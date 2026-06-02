#!/usr/bin/env python3

import serial
import serial.tools.list_ports
import paho.mqtt.client as mqtt
import time
import signal
import sys
import argparse
import json
import struct


# ================= MQTT CONFIG =================
MQTT_HOST = "192.168.0.156"
#MQTT_HOST = "192.168.0.125"
#MQTT_HOST = "10.178.215.92"
MQTT_PORT = 1883

MQTT_TOPIC_LEFT                = "adj/datalogger/sensors/left"
MQTT_TOPIC_RIGHT               = "adj/datalogger/sensors/right"
MQTT_TOPIC_EVENT_GPS           = "adj/datalogger/sensors/gps"
MQTT_TOPIC_EVENT               = "adj/datalogger/sensors/event"

MQTT_TOPIC_HEALTH              = "adj/datalogger/health"
MQTT_TOPIC_HEALTH_JUNCTION_BOX = "adj/datalogger/health/junction_box"
MQTT_TOPIC_HEALTH_DATA_LOGGER  = "adj/datalogger/health/data_logger"

MQTT_TOPIC_CLIENT_REQUEST      = "adj/datalogger/client_request"

BAUD_RATE = 115200

# ================= BINARY PACKET CONSTANTS =================
# S1/S2: 1(type) + 10×4(floats) + 4(ts) + 4(lat) + 4(lon) + 1(sat) + 4(pad) + 6(HHMMSS+DDMM) + 2(year) = 66
SENSOR_PKT_SIZE = 66
# EVENT: 1(type) + 4(ts) + 4(s1_mag) + 4(s2_mag) = 13
EVENT_PKT_SIZE  = 13

SENSOR_STRUCT = '<B10fIffB4xBBBBBBH'
EVENT_STRUCT  = '<BIff'

running = True
ser = None

# ================= SIGNAL =================
def signal_handler(sig, frame):
    global running
    print("\nShutting down...")
    running = False
    sys.exit(0)

signal.signal(signal.SIGINT, signal_handler)

# ================= PORT DETECT =================
def find_stm32_port():
    ports = serial.tools.list_ports.comports()
    for port in ports:
        if "STM" in port.description or "STLink" in port.description:
            print(f"Found STM32 on {port.device}")
            return port.device
    return None

# ================= MQTT RECEIVE =================
def on_message(client, userdata, msg):
    global ser
    try:
        payload = msg.payload.decode().strip()
        print(f"\n Received from MQTT: {payload}")
        if ser is None:
            print("Serial not ready")
            return
        try:
            data = json.loads(payload)
            command = data.get("cmd", "")
        except:
            command = payload
        if command:
            print(f"➡️ Forwarding to STM32: {command}")
            ser.write((command + "\n").encode())
    except Exception as e:
        print(f"MQTT receive error: {e}")

# ================= BINARY READERS =================
def read_exact(s, n):
    buf = b''
    while len(buf) < n:
        chunk = s.read(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf

def parse_sensor_pkt(raw):
    vals = struct.unpack(SENSOR_STRUCT, raw)
    ptype, ax, ay, az, mag, gx, gy, gz, f8, f9, f10, ts, lat_r, lon_r, sats, ms_v, hh, mm, ss, dd, mo, yr = vals
    return {
        'type': 'sensor',
        'sensor': 'S1' if ptype == 0x01 else 'S2',
        'accel': {
            'x':         round(float(ax),  4),
            'y':         round(float(ay),  4),
            'z':         round(float(az),  4),
            'magnitude': round(float(mag), 4)
        },
        'gyro': {
            'x': round(float(gx), 4),
            'y': round(float(gy), 4),
            'z': round(float(gz), 4)
        },
        'field8':        round(float(f8),  4),
        'field9':        round(float(f9),  4),
        'field10':       round(float(f10), 4),
        'timestamp_ms':  int(ts),
        'gps': {
            'lat':        round(float(lat_r) / 1e6, 6),
            'lon':        round(float(lon_r) / 1e6, 6),
            'satellites': int(sats)
        },
        'time': f'{hh:02d}:{mm:02d}:{ss:02d}',
        'date': f'{dd:02d}/{mo:02d}/{yr:04d}'
    }

def parse_event_pkt(raw):
    ptype, ts, s1_mag, s2_mag = struct.unpack(EVENT_STRUCT, raw)
    return {
        'type':         'event',
        'timestamp_ms': int(ts),
        's1': {'magnitude': round(float(s1_mag), 4)},
        's2': {'magnitude': round(float(s2_mag), 4)}
    }

# ================= TEXT LINE PROCESSOR =================
def process_text_line(line, state, client):
    """Handle text-format lines (health blocks, legacy text sensor packets)."""

    # HEALTH START
    if "[HEALTH]" in line:
        state['health_active'] = True
        state['health_buf'] = [line]
        return

    # HEALTH COLLECT
    if state.get('health_active'):
        state['health_buf'].append(line)
        if "====" in line:
            health_data = "\n".join(state['health_buf'])
            client.publish(MQTT_TOPIC_HEALTH, health_data)
            print("\n🩺 HEALTH SENT\n" + health_data)
            state['health_buf'] = []
            state['health_active'] = False
        return

    # EVENT START (text fallback)
    if "VIBRATION ALERT" in line:
        state['event_active'] = True
        state['event_buf'] = [line]
        return

    # EVENT COLLECT (text fallback)
    if state.get('event_active'):
        state['event_buf'].append(line)
        if "[AXLE BOX" in line:
            event_data = "\n".join(state['event_buf'][:-1])
            client.publish(MQTT_TOPIC_EVENT, event_data)
            print("\n🚨 EVENT SENT (text)\n" + event_data)
            state['event_buf'] = []
            state['event_active'] = False
            state['current_sensor'] = None
        return

    # LEFT / RIGHT sensor blocks (text fallback)
    if "[AXLE BOX LEFT" in line:
        state['current_sensor'] = "LEFT"
        state['left_buf'] = [line]
        return

    if "[AXLE BOX RIGHT" in line:
        state['current_sensor'] = "RIGHT"
        state['right_buf'] = [line]
        return

    if state.get('current_sensor') == "LEFT":
        state.setdefault('left_buf', []).append(line)
    elif state.get('current_sensor') == "RIGHT":
        state.setdefault('right_buf', []).append(line)

    if "WINDOW" in line:
        if state.get('left_buf'):
            left_data = "\n".join(state['left_buf'])
            client.publish(MQTT_TOPIC_LEFT, left_data)
            print("\n📡 LEFT SENT (text)\n" + left_data)
            state['left_buf'] = []
        if state.get('right_buf'):
            right_data = "\n".join(state['right_buf'])
            client.publish(MQTT_TOPIC_RIGHT, right_data)
            print("\n📡 RIGHT SENT (text)\n" + right_data)
            state['right_buf'] = []
        state['current_sensor'] = None

# ================= MAIN =================
def main():
    global running, ser

    parser = argparse.ArgumentParser()
    parser.add_argument("-t", "--tty", help="Serial port")
    args = parser.parse_args()

    port = args.tty if args.tty else find_stm32_port()
    if not port:
        port = input("Enter serial port: ")

    try:
        ser = serial.Serial(port, BAUD_RATE, timeout=1)
        print(f"Connected to STM32 on {port}")
    except Exception as e:
        print(f"Serial error: {e}")
        return

    client = mqtt.Client()
    client.on_message = on_message
    try:
        client.connect(MQTT_HOST, MQTT_PORT, 60)
        client.subscribe(MQTT_TOPIC_CLIENT_REQUEST)
        client.loop_start()
        print(f"MQTT Connected → {MQTT_HOST}")
        print(f"Subscribed to → {MQTT_TOPIC_CLIENT_REQUEST}")
    except Exception as e:
        print(f"MQTT error: {e}")
        return

    print("\nReading data...\n")

    text_buf = b''
    state = {
        'health_active':  False,
        'health_buf':     [],
        'event_active':   False,
        'event_buf':      [],
        'current_sensor': None,
        'left_buf':       [],
        'right_buf':      []
    }

    while running:
        try:
            byte = ser.read(1)
            if not byte:
                continue

            b = byte[0]

            # ── Binary sensor packet (S1=0x01, S2=0x02) ──────────────────
            if b in (0x01, 0x02):
                text_buf = b''
                rest = read_exact(ser, SENSOR_PKT_SIZE - 1)
                if not rest:
                    print("Incomplete sensor packet — skipped")
                    continue
                try:
                    pkt   = parse_sensor_pkt(byte + rest)
                    topic = MQTT_TOPIC_LEFT if b == 0x01 else MQTT_TOPIC_RIGHT
                    client.publish(topic, json.dumps(pkt))
                    print(f"\n📡 {pkt['sensor']} → {topic}")
                    print(f"   Accel : {pkt['accel']}")
                    print(f"   Gyro  : {pkt['gyro']}")
                    print(f"   GPS   : {pkt['gps']}  {pkt['time']} {pkt['date']}")
                except struct.error as e:
                    print(f"Sensor packet parse error: {e}")
                continue

            # ── Binary event packet (EVENT=0x03) ──────────────────────────
            if b == 0x03:
                text_buf = b''
                rest = read_exact(ser, EVENT_PKT_SIZE - 1)
                if not rest:
                    print("Incomplete event packet — skipped")
                    continue
                try:
                    pkt = parse_event_pkt(byte + rest)
                    client.publish(MQTT_TOPIC_EVENT, json.dumps(pkt))
                    print(f"\n🚨 EVENT → {MQTT_TOPIC_EVENT}")
                    print(f"   S1={pkt['s1']['magnitude']}g  S2={pkt['s2']['magnitude']}g")
                except struct.error as e:
                    print(f"Event packet parse error: {e}")
                continue

            # ── Text byte accumulation ────────────────────────────────────
            if b == ord('\n'):
                line = text_buf.decode('utf-8', errors='ignore').strip()
                text_buf = b''
                if line:
                    process_text_line(line, state, client)
            elif b != ord('\r'):
                text_buf += byte

        except Exception as e:
            print(f"Error: {e}")

    if ser:
        ser.close()
    client.loop_stop()
    client.disconnect()


# ================= ENTRY =================
if __name__ == "__main__":
    main()
