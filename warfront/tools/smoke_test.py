#!/usr/bin/env python3
"""Дымовой тест: запускает выделенный сервер Forge с модом, выполняет игровые сценарии командами
и падает, если в логе есть исключения. Запуск из папки warfront: python3 tools/smoke_test.py"""
import os, subprocess, sys, threading, time, queue

os.makedirs('run', exist_ok=True)
open('run/eula.txt', 'w').write('eula=true\n')
open('run/server.properties', 'w').write(
    'online-mode=false\nlevel-type=minecraft\\:flat\ngenerate-structures=false\nspawn-protection=0\n'
    'view-distance=6\nsimulation-distance=6\nmax-tick-time=-1\n')

cmd = ['gradle', 'runServer', '--no-daemon', '-q']
p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                     text=True, bufsize=1)
lines = []
q = queue.Queue()


def reader():
    for line in p.stdout:
        lines.append(line)
        sys.stdout.write(line)
        q.put(line)
    q.put(None)


threading.Thread(target=reader, daemon=True).start()


def say(c):
    print(f'\n>>> {c}', flush=True)
    p.stdin.write(c + '\n')
    p.stdin.flush()


def wait_for(marker, timeout):
    end = time.time() + timeout
    while time.time() < end:
        try:
            l = q.get(timeout=1)
        except queue.Empty:
            continue
        if l is None:
            return False
        if marker in l:
            return True
    return False


ok = wait_for('Done (', 900)
if not ok:
    print('СЕРВЕР НЕ ЗАПУСТИЛСЯ')
    p.kill()
    sys.exit(1)

scenario = [
    'warfront status',
    'execute in minecraft:overworld run setblock 0 -59 0 warfront:headquarters',   # основание королевства
    'execute in minecraft:overworld run setblock 3 -59 0 warfront:house',
    'execute in minecraft:overworld run setblock 5 -59 0 warfront:barracks',
    'execute in minecraft:overworld run setblock 7 -59 0 warfront:farm',
    'execute in minecraft:overworld run setblock 9 -59 0 warfront:factory',
    'execute in minecraft:overworld run summon warfront:tank 0 -58 5',
    'execute in minecraft:overworld run summon warfront:soldier 2 -58 5',
    'warfront raid',
    'warfront outpost',
]
for c in scenario:
    say(c)
    time.sleep(3)

time.sleep(75)  # несколько ходов экономики и бой
say('warfront status')
time.sleep(3)
say('stop')
try:
    p.wait(timeout=120)
except subprocess.TimeoutExpired:
    p.kill()

bad = [l for l in lines if ('Exception' in l or '/ERROR]' in l or 'Caught exception' in l or 'crash' in l.lower())
       and 'ignoring' not in l.lower()]
status = [l for l in lines if 'Население' in l or 'Королевство не основано' in l]
print('\n=== ИТОГ ===')
print('статус королевства:', status[-1].strip() if status else 'нет')
if bad:
    print('НАЙДЕНЫ ОШИБКИ В ЛОГЕ:')
    for l in bad[:40]:
        print('  ', l.rstrip())
    sys.exit(1)
if not status or 'не основано' in status[-1]:
    print('Королевство не было основано — сценарий не сработал')
    sys.exit(1)
print('Дымовой тест пройден')
