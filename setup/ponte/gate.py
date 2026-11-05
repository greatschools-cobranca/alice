#!/usr/bin/env python3
"""Verificação sem IA antes da rotina. Sem cache e sem seguir redirecionamentos."""
import http.client
import json
import sys
from pathlib import Path
from urllib.parse import urlsplit

CONFIG = Path('/data/.config/torre-de-controle/bridge-install.json')

def decide(config, routine_id, expected_version, connection=http.client.HTTPSConnection):
    mapping = config.get('mappings', {}).get(routine_id)
    if not mapping or mapping.get('version') != expected_version:
        return False, 'version'
    origin = urlsplit(config['origin'])
    if origin.scheme != 'https' or origin.username or origin.password or origin.path not in ('', '/') or origin.query or origin.fragment:
        return False, 'origin'
    conn = connection(origin.hostname, origin.port or 443, timeout=8)
    try:
        conn.request('GET', '/api/routines/gate', headers={'Accept': 'application/json', 'Cache-Control': 'no-cache'})
        response = conn.getresponse()
        if response.status != 200 or 'application/json' not in response.getheader('Content-Type', '').lower():
            return False, 'unavailable'
        raw = response.read(256001)
        if len(raw) > 256000:
            return False, 'unavailable'
        body = json.loads(raw)
        if body.get('protocol') != 2:
            return False, 'version'
        for routine in body.get('routines', []):
            if routine.get('id') == routine_id:
                if routine.get('version') != expected_version:
                    return False, 'version'
                return routine.get('on') is True, 'on' if routine.get('on') is True else 'off'
        return False, 'unknown'
    finally:
        conn.close()

def main():
    fire, reason = False, 'unavailable'
    try:
        if len(sys.argv) == 3:
            fire, reason = decide(json.loads(CONFIG.read_text()), sys.argv[1], sys.argv[2])
    except Exception:
        pass
    print(json.dumps({'torre_gate': 'v2', 'fire': fire, 'reason': reason}, separators=(',', ':')))

if __name__ == '__main__':
    main()
