#!/usr/bin/env python3
"""Дымовой тест: запускает выделенный сервер Forge с модом, строит базу командами, проверяет жильё и экономику
и падает при исключениях в логе. Запуск из папки warfront: python3 tools/smoke_test.py"""
import os, subprocess, sys, threading, time, queue

os.makedirs('run', exist_ok=True)
open('run/eula.txt', 'w').write('eula=true\n')
open('run/server.properties', 'w').write(
    'online-mode=false\ngenerate-structures=false\nspawn-protection=0\n'
    'view-distance=6\nsimulation-distance=6\nmax-tick-time=-1\nlevel-name=world\n')

p = subprocess.Popen(['gradle', 'runServer', '--no-daemon', '-q'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                     stderr=subprocess.STDOUT, text=True, bufsize=1)
lines = []
q = queue.Queue()


def reader():
    for line in p.stdout:
        lines.append(line)
        sys.stdout.write(line)
        q.put(line)
    q.put(None)


threading.Thread(target=reader, daemon=True).start()


def say(c, pause=0.7):
    print(f'\n>>> {c}', flush=True)
    p.stdin.write(c + '\n')
    p.stdin.flush()
    time.sleep(pause)


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


if not wait_for('Done (', 900):
    print('СЕРВЕР НЕ ЗАПУСТИЛСЯ')
    p.kill()
    sys.exit(1)

OW = 'execute in minecraft:overworld run '


def room(x0, z0, size, y=148, height=5, door_x=None, door_z=None, bed_x=None, bed_z=None, beds=1, torch=None, marker=None, kind=None):
    """Комната-коробка: пол на y, стены/потолок из камня, дверь, кровати, факел, знак здания."""
    x1, z1 = x0 + size + 1, z0 + size + 1
    say(f'{OW}fill {x0} {y} {z0} {x1} {y + height} {z1} minecraft:stone_bricks hollow')
    if door_x is not None:
        say(f'{OW}setblock {door_x} {y + 1} {door_z} minecraft:oak_door[facing=east,half=lower]')
        say(f'{OW}setblock {door_x} {y + 2} {door_z} minecraft:oak_door[facing=east,half=upper]')
    for i in range(beds):
        bx = bed_x + i * 2
        say(f'{OW}setblock {bx} {y + 1} {bed_z} minecraft:red_bed[facing=south,part=foot]')
        say(f'{OW}setblock {bx} {y + 1} {bed_z + 1} minecraft:red_bed[facing=south,part=head]')
    if torch:
        say(f'{OW}setblock {torch[0]} {y + 1} {torch[1]} minecraft:torch')
    if marker:
        say(f'{OW}setblock {marker[0]} {y + 1} {marker[1]} warfront:{kind}')


say('warfront status')
say(f'{OW}fill -14 148 -14 56 148 42 minecraft:stone', 2)                         # площадка
say(f'{OW}setblock 0 149 0 warfront:headquarters', 2)                              # штаб - основание королевства
# ферма: грядки с пшеницей
say(f'{OW}fill 14 148 -8 19 148 -4 minecraft:farmland')
say(f'{OW}fill 14 149 -8 19 149 -4 minecraft:wheat[age=7]')
say(f'{OW}setblock 16 149 -10 warfront:farm')
# дом 6x6 с кроватью, дверью, светом - должен быть принят
room(20, 20, 6, door_x=20, door_z=23, bed_x=22, bed_z=22, beds=1, torch=(25, 25), marker=(25, 22), kind='house')
# знак дома под открытым небом - должен быть отклонён
say(f'{OW}setblock 44 149 22 warfront:house')
# казарма 10x10, 2 кровати
room(30, 0, 10, door_x=30, door_z=5, bed_x=32, bed_z=2, beds=2, torch=(36, 8), marker=(38, 8), kind='barracks')
# мастерская 6x6
room(44, 0, 6, door_x=44, door_z=3, bed_x=0, bed_z=0, beds=0, torch=(48, 5), marker=(49, 6), kind='workshop')
# танковый завод 10x10
room(-12, 8, 10, door_x=-1, door_z=13, bed_x=0, bed_z=0, beds=0, torch=(-6, 10), marker=(-6, 17), kind='factory')
# витрина всех блоков мода (для скриншотов)
for i, blk in enumerate(['headquarters', 'house', 'barracks', 'farm', 'workshop', 'armory', 'factory', 'enemy_flag']):
    say(f'{OW}setblock {-10 + i * 2} 149 -12 warfront:{blk}', 0.3)
# армия
say(f'{OW}summon warfront:tank 4 149 10')
say(f'{OW}summon warfront:tank -3 149 4')
for sx, sz in [(2, 8), (6, 8), (8, 12), (10, 6)]:
    say(f'{OW}summon warfront:soldier {sx} 149 {sz}')
say(f'{OW}summon warfront:soldier 12 149 14 {{Enemy:1b,Squad:1}}')
say('warfront raid')
say('warfront outpost')
time.sleep(8)
say('warfront buildings', 2)
time.sleep(70)     # несколько ходов экономики
say('warfront status', 2)
say('warfront buildings', 2)
say('save-all flush', 6)
say('stop', 1)
try:
    p.wait(timeout=120)
except subprocess.TimeoutExpired:
    p.kill()

text = ''.join(lines)
bad = [l for l in lines if ('Exception' in l or '/ERROR]' in l or 'Caught exception' in l or 'crash' in l.lower())
       and 'ignoring' not in l.lower() and 'setAccessible' not in l and 'IllegalAccessException' not in l
       and 'jdk.internal' not in l]
fails = []
for need in ['[OK] Дом', '[НЕТ] Дом', '[OK] Казарма', '[OK] Ферма', '[OK] Мастерская', '[OK] Танковый завод']:
    if need not in text:
        fails.append(f'в выводе нет «{need}»')
status = [l for l in lines if 'Население' in l]
print('\n=== ИТОГ ===')
print('статус:', status[-1].strip() if status else 'нет')
if not status:
    fails.append('нет статуса королевства')
if bad:
    fails.append('исключения в логе')
    print('НАЙДЕНЫ ОШИБКИ В ЛОГЕ:')
    for l in bad[:40]:
        print('  ', l.rstrip())
if fails:
    print('ПРОВАЛ:', '; '.join(fails))
    sys.exit(1)
print('Дымовой тест пройден')
