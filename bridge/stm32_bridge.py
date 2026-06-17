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
MQTT_HOST = "192.168.1.10"
#MQTT_HOST = "192.168.0.156"
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
# S1/S2 (68 bytes):
#   byte 0      : type (0x01=S1, 0x02=S2)
#   bytes 1-40  : Ax,Ay,Az,RMS_V,RMS_L,SD_V,SD_L,P2P_V,P2P_L,Peak (10 floats)
#   bytes 41-44 : Uptime ms (uint32)
#   bytes 45-48 : Latitude  (float, raw × 1e6)
#   bytes 49-52 : Longitude (float, raw × 1e6)
#   bytes 53-54 : Satellites (uint16)
#   bytes 55-58 : Speed m/s  (float)
#   byte  59    : Hour
#   byte  60    : Minute
#   byte  61    : Second
#   byte  62    : Day
#   byte  63    : Month
#   bytes 64-65 : Year (uint16)
#   bytes 66-67 : CRC16-CCITT
SENSOR_PKT_SIZE = 68
# EVENT (15 bytes):
#   byte 0     : type (0x03)
#   bytes 1-4  : Uptime ms (uint32)
#   bytes 5-8  : S1 Peak   (float)
#   bytes 9-12 : S2 Peak   (float)
#   bytes 13-14: CRC16-CCITT
EVENT_PKT_SIZE  = 15

SENSOR_STRUCT = '<B10fIffHfBBBBBHH'
EVENT_STRUCT  = '<BIffH'

# ================= CRC16-CCITT (poly=0x1021, init=0xFFFF) =================
def crc16(data):
    crc = 0xFFFF
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if (crc & 0x8000) else (crc << 1) & 0xFFFF
    return crc

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
    rx_crc  = struct.unpack_from('<H', raw, 66)[0]
    calc_crc = crc16(raw[:66])
    if rx_crc != calc_crc:
        raise ValueError(f"CRC mismatch: got 0x{rx_crc:04X} expected 0x{calc_crc:04X}")

    ptype, ax, ay, az, rms_v, rms_l, sd_v, sd_l, p2p_v, p2p_l, peak, ts, lat_r, lon_r, sats, speed_ms, hh, mm, ss, dd, mo, yr, _ = struct.unpack(SENSOR_STRUCT, raw)
    return {
        'type':         'sensor',
        'sensor':       'S1' if ptype == 0x01 else 'S2',
        'accel': {
            'x':     round(float(ax),    4),
            'y':     round(float(ay),    4),
            'z':     round(float(az),    4),
        },
        'rms_v':        round(float(rms_v),  4),
        'rms_l':        round(float(rms_l),  4),
        'sd_v':         round(float(sd_v),   4),
        'sd_l':         round(float(sd_l),   4),
        'p2p_v':        round(float(p2p_v),  4),
        'p2p_l':        round(float(p2p_l),  4),
        'peak':         round(float(peak),   4),
        'timestamp_ms': int(ts),
        'gps': {
            'lat':        round(float(lat_r) / 1e6, 6),
            'lon':        round(float(lon_r) / 1e6, 6),
            'satellites': int(sats),
            'speed_kmh':  round(float(speed_ms) * 0.036, 2),  # speed_cms → km/h
        },
        'time': f'{hh:02d}:{mm:02d}:{ss:02d}',
        'date': f'{dd:02d}/{mo:02d}/{yr:04d}'
    }

def parse_event_pkt(raw):
    rx_crc   = struct.unpack_from('<H', raw, 13)[0]
    calc_crc = crc16(raw[:13])
    if rx_crc != calc_crc:
        raise ValueError(f"CRC mismatch: got 0x{rx_crc:04X} expected 0x{calc_crc:04X}")

    ptype, ts, s1_mag, s2_mag, _ = struct.unpack(EVENT_STRUCT, raw)
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

            # ── Binary sensor packet S1=0x01 (left), S2=0x02 (right) ─────
            if b in (0x01, 0x02):
                text_buf = b''
                rest = read_exact(ser, SENSOR_PKT_SIZE - 1)
                if not rest:
                    print("Incomplete sensor packet — skipped")
                    continue
                try:
                    pkt   = parse_sensor_pkt(byte + rest)
                    topic = MQTT_TOPIC_LEFT if b == 0x01 else MQTT_TOPIC_RIGHT
                    client.publish(topic, byte + rest)
                    print(f"\n📡 {pkt['sensor']} → {topic}")
                    print(f"   Accel : {pkt['accel']}")
                    print(f"   Stats : rms_v={pkt['rms_v']} rms_l={pkt['rms_l']} peak={pkt['peak']}")
                    print(f"   GPS   : {pkt['gps']}  {pkt['time']} {pkt['date']}")
                except (struct.error, ValueError) as e:
                    print(f"Sensor packet dropped: {e}")
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
                    client.publish(MQTT_TOPIC_EVENT, byte + rest)
                    print(f"\n🚨 EVENT → {MQTT_TOPIC_EVENT}")
                    print(f"   S1={pkt['s1']['magnitude']}g  S2={pkt['s2']['magnitude']}g")
                except (struct.error, ValueError) as e:
                    print(f"Event packet dropped: {e}")
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
