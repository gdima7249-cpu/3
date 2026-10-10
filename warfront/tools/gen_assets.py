#!/usr/bin/env python3
"""Генерирует текстуры, 3D-модели, рецепты, языки и теги мода. Запуск: python3 tools/gen_assets.py"""
import json, os, random, shutil
from PIL import Image, ImageDraw

ROOT = os.path.join(os.path.dirname(__file__), '..', 'src', 'main', 'resources')
A = os.path.join(ROOT, 'assets', 'warfront')
D = os.path.join(ROOT, 'data', 'warfront')
random.seed(11)
for sub in (os.path.join(A, 'models'), os.path.join(A, 'textures'), os.path.join(A, 'blockstates'),
            os.path.join(D, 'recipes'), os.path.join(D, 'loot_tables')):
    shutil.rmtree(sub, ignore_errors=True)


def w(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(data if isinstance(data, str) else json.dumps(data, ensure_ascii=False, indent=2))


def save(img, rel):
    p = os.path.join(A, 'textures', rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    img.save(p)


def noise(img, amt=12):
    px = img.load()
    for x in range(img.width):
        for y in range(img.height):
            r, g, b, a = px[x, y]
            d = random.randint(-amt, amt)
            px[x, y] = (max(0, min(255, r + d)), max(0, min(255, g + d)), max(0, min(255, b + d)), a)


def dark(c, k=40):
    return tuple(max(0, v - k) for v in c)


def light(c, k=30):
    return tuple(min(255, v + k) for v in c)


# ================= текстуры блоков (палитра для составных моделей) =================
def tex(name, base, kind='flat', accent=None, n=10):
    img = Image.new('RGBA', (16, 16), base + (255,))
    d = ImageDraw.Draw(img)
    if kind == 'bricks':
        for y in range(0, 16, 4):
            d.line([(0, y), (15, y)], fill=dark(base, 38) + (255,))
            off = 0 if (y // 4) % 2 == 0 else 4
            for x in range(off, 16, 8):
                d.line([(x, y), (x, y + 3)], fill=dark(base, 38) + (255,))
    elif kind == 'planks':
        for y in range(0, 16, 4):
            d.line([(0, y), (15, y)], fill=dark(base, 45) + (255,))
        for x in (3, 11):
            d.point((x, 1), fill=dark(base, 60) + (255,))
    elif kind == 'tiles':
        for y in range(0, 16, 3):
            d.line([(0, y), (15, y)], fill=dark(base, 45) + (255,))
            off = 0 if (y // 3) % 2 == 0 else 3
            for x in range(off, 16, 6):
                d.line([(x, y), (x, y + 2)], fill=dark(base, 30) + (255,))
    elif kind == 'plate':
        d.rectangle([0, 0, 15, 15], outline=dark(base, 45) + (255,))
        for p in [(2, 2), (13, 2), (2, 13), (13, 13)]:
            d.point(p, fill=(accent or light(base)) + (255,))
    elif kind == 'crate':
        d.rectangle([0, 0, 15, 15], outline=dark(base, 60) + (255,))
        d.line([(0, 0), (15, 15)], fill=dark(base, 40) + (255,))
        d.line([(15, 0), (0, 15)], fill=dark(base, 40) + (255,))
    elif kind == 'soil':
        for x in range(0, 16, 4):
            d.line([(x, 0), (x, 15)], fill=dark(base, 30) + (255,))
    elif kind == 'door':
        d.rectangle([1, 1, 14, 14], outline=dark(base, 50) + (255,))
        d.line([(8, 1), (8, 14)], fill=dark(base, 50) + (255,))
        d.point((6, 8), fill=(220, 190, 70, 255))
        d.point((10, 8), fill=(220, 190, 70, 255))
    elif kind == 'cloth':
        for y in range(0, 16, 4):
            d.line([(0, y), (15, y)], fill=light(base, 18) + (255,))
    noise(img, n)
    save(img, f'block/{name}.png')


tex('wall_plank', (176, 134, 84), 'planks')
tex('roof_tile', (160, 62, 52), 'tiles')
tex('stone_brick', (122, 124, 118), 'bricks')
tex('steel', (112, 118, 128), 'plate', accent=(230, 140, 40))
tex('dark_metal', (58, 62, 70), 'plate')
tex('crate', (150, 112, 62), 'crate')
tex('soil', (96, 66, 40), 'soil')
tex('wheat', (214, 190, 80), 'soil', n=18)
tex('cloth_red', (186, 40, 40), 'cloth')
tex('cloth_green', (62, 130, 62), 'cloth')
tex('cloth_black', (28, 28, 32), 'cloth')
tex('gold', (230, 196, 70), 'plate')
tex('door_wood', (120, 84, 48), 'door')
tex('grass', (92, 150, 62), 'flat', n=16)
tex('concrete', (150, 150, 150), 'flat', n=8)

# ================= 3D-модели блоков из элементов =================


def el(a, b, t, **kw):
    e = {"from": a, "to": b, "faces": {f: {"texture": "#" + t} for f in ("north", "south", "east", "west", "up", "down")}}
    e.update(kw)
    return e


def block_model(name, textures, elements):
    w(f'{A}/models/block/{name}.json', {
        "parent": "minecraft:block/block",
        "textures": {**{k: f"warfront:block/{v}" for k, v in textures.items()}, "particle": f"warfront:block/{list(textures.values())[0]}"},
        "elements": elements})


# Дом - коттедж с двускатной крышей-ступенькой, дверью и трубой
block_model('house', {'wall': 'wall_plank', 'roof': 'roof_tile', 'door': 'door_wood', 'base': 'stone_brick'}, [
    el([0, 0, 0], [16, 2, 16], 'base'),
    el([1, 2, 1], [15, 9, 15], 'wall'),
    el([0, 9, 0], [16, 11, 16], 'roof'),
    el([2, 11, 2], [14, 13, 14], 'roof'),
    el([4, 13, 4], [12, 15, 12], 'roof'),
    el([6, 15, 6], [10, 16, 10], 'roof'),
    el([6, 2, 14.9], [10, 8, 15.1], 'door'),
    el([11, 13, 3], [13, 16, 5], 'base')])
# Казарма - длинное каменное здание с плоской крышей и флагом
block_model('barracks', {'wall': 'stone_brick', 'roof': 'dark_metal', 'flag': 'cloth_green', 'door': 'door_wood', 'wood': 'wall_plank'}, [
    el([0, 0, 1], [16, 9, 15], 'wall'),
    el([-0.5, 9, 0.5], [16.5, 10.5, 15.5], 'roof'),
    el([6, 1, 14.9], [10, 7, 15.1], 'door'),
    el([1, 10, 2], [1.8, 16, 2.8], 'wood'),
    el([1.8, 12.5, 2.1], [6.8, 15.8, 2.7], 'flag'),
    el([3, 4, 0.9], [5, 6, 1.1], 'door'), el([11, 4, 0.9], [13, 6, 1.1], 'door')])
# Ферма - грядки с колосьями и ограждением
block_model('farm', {'soil': 'soil', 'wheat': 'wheat', 'wood': 'wall_plank', 'grass': 'grass'}, [
    el([0, 0, 0], [16, 3, 16], 'soil'),
    el([0, 3, 0], [16, 4, 1], 'wood'), el([0, 3, 15], [16, 4, 16], 'wood'),
    el([0, 3, 1], [1, 4, 15], 'wood'), el([15, 3, 1], [16, 4, 15], 'wood'),
    el([2, 3, 2], [4, 10, 14], 'wheat'), el([6, 3, 2], [8, 10, 14], 'wheat'),
    el([10, 3, 2], [12, 10, 14], 'wheat'), el([13.5, 3, 2], [14.5, 8, 14], 'wheat')])
# Мастерская - корпус с трубой и верстаком-наковальней
block_model('workshop', {'body': 'steel', 'pipe': 'dark_metal', 'wood': 'wall_plank', 'gold': 'gold'}, [
    el([0, 0, 0], [16, 2, 16], 'pipe'),
    el([1, 2, 2], [11, 9, 14], 'body'),
    el([11, 2, 3], [15, 16, 7], 'pipe'),
    el([11, 2, 9], [15, 6, 13], 'wood'),
    el([2, 9, 3], [10, 10, 13], 'pipe'),
    el([4, 10, 6], [8, 12, 10], 'gold')])
# Оружейная - ящики с боеприпасами
block_model('armory', {'crate': 'crate', 'metal': 'dark_metal', 'gold': 'gold'}, [
    el([0, 0, 0], [8, 8, 8], 'crate'), el([8, 0, 0], [16, 8, 8], 'crate'),
    el([0, 0, 8], [8, 8, 16], 'crate'), el([4, 8, 2], [12, 15, 10], 'crate'),
    el([9, 0, 9], [15, 5, 15], 'metal'), el([10.5, 5, 10.5], [13.5, 7, 13.5], 'gold')])
# Танковый завод - ангар с трубами
block_model('factory', {'wall': 'steel', 'roof': 'dark_metal', 'door': 'dark_metal', 'gold': 'gold'}, [
    el([0, 0, 0], [16, 8, 16], 'wall'),
    el([1, 8, 1], [15, 10, 15], 'roof'),
    el([4, 0, 15.9], [12, 6, 16.1], 'door'),
    el([2, 10, 2], [5, 16, 5], 'roof'), el([11, 10, 2], [14, 16, 5], 'roof'),
    el([7, 10, 7], [9, 12, 9], 'gold')])
# Штаб - башня с флагом
block_model('headquarters', {'wall': 'stone_brick', 'roof': 'dark_metal', 'flag': 'cloth_red', 'gold': 'gold', 'door': 'door_wood'}, [
    el([0, 0, 0], [16, 4, 16], 'wall'),
    el([3, 4, 3], [13, 11, 13], 'wall'),
    el([2, 11, 2], [14, 13, 14], 'roof'),
    el([7.4, 13, 7.4], [8.6, 16, 8.6], 'gold'),
    el([8.6, 13.2, 7.6], [15, 15.8, 8.4], 'flag'),
    el([6, 4, 12.9], [10, 9, 13.1], 'door'),
    el([0, 4, 0], [3, 8, 3], 'wall'), el([13, 4, 0], [16, 8, 3], 'wall'),
    el([0, 4, 13], [3, 8, 16], 'wall'), el([13, 4, 13], [16, 8, 16], 'wall')])
# Вражеский флаг - мачта и чёрное полотнище
block_model('enemy_flag', {'cloth': 'cloth_black', 'pole': 'dark_metal', 'red': 'cloth_red'}, [
    el([7, 0, 7], [9, 16, 9], 'pole'),
    el([9, 6, 7.6], [16, 15, 8.4], 'cloth'),
    el([11, 9, 7.5], [14, 12, 8.5], 'red')])

BUILD = ['headquarters', 'house', 'barracks', 'farm', 'workshop', 'armory', 'factory']
for b in BUILD + ['enemy_flag']:
    w(f'{A}/blockstates/{b}.json', {"variants": {"": {"model": f"warfront:block/{b}"}}})
    w(f'{A}/models/item/{b}.json', {"parent": f"warfront:block/{b}"})
    if b != 'enemy_flag':
        w(f'{D}/loot_tables/blocks/{b}.json', {
            "type": "minecraft:block",
            "pools": [{"rolls": 1, "entries": [{"type": "minecraft:item", "name": f"warfront:{b}"}],
                       "conditions": [{"condition": "minecraft:survives_explosion"}]}]})

# ================= текстуры и 3D-модели предметов =================
def itex(name, color, noise_amt=8):
    img = Image.new('RGBA', (8, 8), color + (255,))
    noise(img, noise_amt)
    save(img, f'item/{name}.png')


itex('gun_dark', (44, 46, 52))
itex('gun_metal', (110, 116, 124))
itex('gun_wood', (126, 84, 44))
itex('gun_olive', (82, 98, 60))
itex('gun_red', (190, 50, 44))
itex('gun_gold', (222, 186, 60))
GUN_TEX = {"dark": "warfront:item/gun_dark", "metal": "warfront:item/gun_metal", "wood": "warfront:item/gun_wood",
           "olive": "warfront:item/gun_olive", "red": "warfront:item/gun_red", "gold": "warfront:item/gun_gold",
           "particle": "warfront:item/gun_dark"}

# Оружие моделируется вдоль оси Z: дуло в z=0, приклад в z=16. Руки держат за центр.
GUN_DISPLAY = {
    "thirdperson_righthand": {"rotation": [0, 0, 0], "translation": [0, 2.5, -2.5], "scale": [0.9, 0.9, 0.9]},
    "thirdperson_lefthand": {"rotation": [0, 0, 0], "translation": [0, 2.5, -2.5], "scale": [0.9, 0.9, 0.9]},
    "firstperson_righthand": {"rotation": [0, -4, 0], "translation": [2.2, -1.6, -3], "scale": [0.85, 0.85, 0.85]},
    "firstperson_lefthand": {"rotation": [0, 4, 0], "translation": [-2.2, -1.6, -3], "scale": [0.85, 0.85, 0.85]},
    "gui": {"rotation": [20, -128, 0], "translation": [0, 0, 0], "scale": [0.95, 0.95, 0.95]},
    "ground": {"rotation": [0, 0, 0], "translation": [0, 3, 0], "scale": [0.6, 0.6, 0.6]},
    "fixed": {"rotation": [0, 90, 0], "translation": [0, 0, 0], "scale": [1, 1, 1]},
}


def gun(name, elements):
    w(f'{A}/models/item/{name}.json', {"textures": GUN_TEX, "elements": elements, "display": GUN_DISPLAY,
                                       "gui_light": "front"})


gun('rifle', [
    el([7.3, 8.8, 0], [8.7, 10.0, 8], 'metal'),          # ствол
    el([6.8, 8.0, 5], [9.2, 10.4, 10], 'wood'),          # цевьё
    el([6.9, 7.4, 9], [9.1, 10.6, 13.5], 'dark'),        # ствольная коробка
    el([7.1, 6.2, 13.5], [8.9, 10.2, 16], 'wood'),       # приклад
    el([7.3, 4.8, 10.8], [8.7, 7.6, 12.2], 'wood'),      # рукоять
    el([7.4, 4.0, 8.2], [8.6, 7.4, 9.6], 'dark'),        # магазин
    el([7.5, 10.6, 9.5], [8.5, 11.4, 12], 'dark'),       # прицел
    el([7.6, 10.2, 0.4], [8.4, 10.8, 1.0], 'dark')])     # мушка
gun('smg', [
    el([7.4, 8.8, 0], [8.6, 9.8, 5], 'metal'),
    el([6.8, 7.8, 4], [9.2, 10.6, 11], 'dark'),
    el([7.4, 4.2, 6.5], [8.6, 7.8, 8], 'dark'),          # длинный магазин
    el([7.3, 5.0, 10], [8.7, 7.8, 11.4], 'wood'),
    el([7.2, 7.8, 11], [8.8, 10.2, 15], 'metal'),        # складной приклад
    el([7.5, 10.6, 5], [8.5, 11.2, 7], 'dark')])
gun('shotgun', [
    el([7.2, 9.0, 0], [8.8, 10.4, 11], 'metal'),
    el([7.0, 7.6, 3], [9.0, 9.0, 9], 'wood'),            # подствольное цевьё
    el([6.9, 7.8, 10], [9.1, 10.8, 13], 'dark'),
    el([7.1, 5.6, 13], [8.9, 10.4, 16], 'wood'),
    el([7.3, 5.2, 10.6], [8.7, 7.8, 11.8], 'wood')])
gun('rocket_launcher', [
    el([6.2, 8.0, 0], [9.8, 11.6, 12], 'olive'),         # труба
    el([5.6, 7.4, 0], [10.4, 12.2, 2], 'dark'),          # раструб
    el([5.8, 7.6, 11.5], [10.2, 12.0, 14], 'dark'),
    el([7.4, 5.4, 6], [8.6, 8.0, 7.4], 'dark'),          # рукоять
    el([7.4, 5.4, 9.5], [8.6, 8.0, 10.9], 'dark'),
    el([7.6, 11.6, 4], [8.4, 12.8, 8], 'metal'),         # прицел
    el([6.5, 11.0, 2.5], [9.5, 11.4, 3.5], 'red')])


def small_item(name, painter):
    img = Image.new('RGBA', (16, 16), (0, 0, 0, 0))
    painter(ImageDraw.Draw(img))
    save(img, f'item/{name}.png')
    w(f'{A}/models/item/{name}.json', {"parent": "minecraft:item/generated", "textures": {"layer0": f"warfront:item/{name}"}})


dk, gy, br, gd, rd = (40, 40, 45, 255), (130, 135, 140, 255), (110, 70, 35, 255), (240, 200, 60, 255), (200, 40, 40, 255)


def tablet(d):
    d.rectangle([2, 1, 13, 14], fill=(30, 30, 36, 255), outline=(12, 12, 14, 255))
    d.rectangle([3, 2, 12, 12], fill=(36, 112, 70, 255))
    d.line([(4, 10), (7, 6), (9, 8), (12, 4)], fill=(255, 255, 255, 255))
    d.point((12, 4), fill=rd)
    d.point((7, 6), fill=gd)
    d.rectangle([6, 13, 9, 13], fill=gy)


def ammo(d):
    d.rectangle([3, 6, 12, 13], fill=(70, 78, 56, 255), outline=(30, 34, 24, 255))
    d.rectangle([3, 6, 12, 8], fill=(90, 100, 70, 255))
    for x in (4, 6, 8, 10):
        d.rectangle([x, 3, x + 1, 6], fill=gd)
        d.point((x, 3), fill=(255, 235, 150, 255))


def rocket(d):
    d.line([(3, 13), (11, 5)], fill=(88, 100, 78, 255), width=3)
    d.polygon([(11, 5), (14, 2), (13, 6)], fill=rd)
    d.point((2, 14), fill=(250, 150, 40, 255))
    d.point((3, 14), fill=(250, 210, 80, 255))


small_item('tablet', tablet)
small_item('ammo', ammo)
small_item('rocket', rocket)

# ================= текстуры сущностей =================
def soldier(name, cloth, cloth2, skin, accent):
    img = Image.new('RGBA', (64, 64), cloth + (255,))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, 31, 15], fill=skin + (255,))
    d.rectangle([8, 8, 15, 15], fill=skin + (255,))
    d.rectangle([10, 11, 11, 11], fill=(30, 30, 40, 255))
    d.rectangle([13, 11, 14, 11], fill=(30, 30, 40, 255))
    d.rectangle([10, 14, 14, 14], fill=(125, 72, 62, 255))
    d.rectangle([16, 16, 39, 31], fill=cloth2 + (255,))
    d.rectangle([20, 20, 27, 22], fill=accent + (255,))      # нашивка на груди
    d.rectangle([40, 16, 55, 31], fill=cloth + (255,))
    d.rectangle([0, 16, 15, 31], fill=cloth2 + (255,))
    d.rectangle([16, 48, 47, 63], fill=cloth + (255,))
    noise(img, 12)
    save(img, f'entity/{name}.png')


soldier('soldier', (74, 100, 60), (58, 82, 48), (226, 178, 140), (230, 200, 70))
soldier('soldier_enemy', (112, 62, 56), (88, 48, 44), (210, 160, 125), (30, 30, 34))

tank = Image.new('RGBA', (128, 128), (84, 98, 58, 255))
d = ImageDraw.Draw(tank)
d.rectangle([0, 0, 104, 39], fill=(84, 98, 58, 255))               # корпус
for x in range(0, 105, 13):
    d.line([(x, 0), (x, 39)], fill=(66, 78, 46, 255))
d.rectangle([0, 40, 82, 83], fill=(46, 48, 44, 255))               # гусеницы
for x in range(0, 83, 5):
    d.line([(x, 40), (x, 83)], fill=(28, 29, 27, 255))
d.rectangle([0, 84, 68, 128], fill=(96, 112, 66, 255))             # башня
d.rectangle([70, 84, 127, 128], fill=(54, 58, 52, 255))            # ствол
d.rectangle([84, 100, 96, 106], fill=(200, 180, 60, 255))
noise(tank, 12)
save(tank, 'entity/tank.png')

# ================= рецепты =================
def shaped(name, pattern, key, result, count=1):
    w(f'{D}/recipes/{name}.json', {
        "type": "minecraft:crafting_shaped", "category": "misc", "pattern": pattern,
        "key": {k: {"item": v} for k, v in key.items()},
        "result": {"item": f"warfront:{result}", "count": count}})


shaped('house', ["PPP", "PCP", "PPP"], {"P": "minecraft:oak_planks", "C": "minecraft:cobblestone"}, 'house')
shaped('barracks', ["CCC", "CIC", "CCC"], {"C": "minecraft:cobblestone", "I": "minecraft:iron_ingot"}, 'barracks')
shaped('farm', ["SSS", "DDD", "DDD"], {"S": "minecraft:wheat_seeds", "D": "minecraft:dirt"}, 'farm')
shaped('workshop', ["III", "IFI", "III"], {"I": "minecraft:iron_ingot", "F": "minecraft:furnace"}, 'workshop')
shaped('armory', ["III", "IGI", "III"], {"I": "minecraft:iron_ingot", "G": "minecraft:gunpowder"}, 'armory')
shaped('factory', ["BBB", "BFB", "BBB"], {"B": "minecraft:iron_block", "F": "minecraft:furnace"}, 'factory')
shaped('headquarters', ["IGI", "GWG", "IGI"], {"I": "minecraft:iron_ingot", "G": "minecraft:gold_ingot", "W": "minecraft:red_wool"}, 'headquarters')
shaped('tablet', ["III", "IMI", "III"], {"I": "minecraft:iron_ingot", "M": "minecraft:map"}, 'tablet')
shaped('rifle', ["  I", "III", " S "], {"I": "minecraft:iron_ingot", "S": "minecraft:stick"}, 'rifle')
shaped('smg', ["III", "ISI", " S "], {"I": "minecraft:iron_ingot", "S": "minecraft:stick"}, 'smg')
shaped('shotgun', ["III", "SS "], {"I": "minecraft:iron_ingot", "S": "minecraft:stick"}, 'shotgun')
shaped('rocket_launcher', ["III", "GBG", " S "], {"I": "minecraft:iron_ingot", "G": "minecraft:gunpowder", "B": "minecraft:iron_block", "S": "minecraft:stick"}, 'rocket_launcher')
w(f'{D}/recipes/ammo.json', {"type": "minecraft:crafting_shapeless", "category": "misc",
                              "ingredients": [{"item": "minecraft:iron_ingot"}, {"item": "minecraft:gunpowder"}],
                              "result": {"item": "warfront:ammo", "count": 8}})
w(f'{D}/recipes/rocket.json', {"type": "minecraft:crafting_shapeless", "category": "misc",
                                "ingredients": [{"item": "minecraft:gunpowder"}, {"item": "minecraft:gunpowder"},
                                                {"item": "minecraft:iron_ingot"}],
                                "result": {"item": "warfront:rocket", "count": 2}})

# ================= теги и языки =================
opt = lambda i: {"id": i, "required": False}
w(f'{D}/tags/items/soldier_weapons.json', {"replace": False, "values": [
    "warfront:rifle", "warfront:smg", "warfront:shotgun", "warfront:rocket_launcher",
    opt("cgm:pistol"), opt("cgm:shotgun"), opt("cgm:rifle"), opt("cgm:assault_rifle"),
    opt("cgm:bazooka"), opt("cgm:mini_gun"), opt("cgm:grenade_launcher"),
    opt("tacz:modern_kinetic_gun"), opt("pointblank:m4a1"), opt("pointblank:ak47")]})

ru = {
    "item.warfront.tablet": "Командирский планшет", "item.warfront.rifle": "Винтовка", "item.warfront.smg": "Пистолет-пулемёт",
    "item.warfront.shotgun": "Дробовик", "item.warfront.rocket_launcher": "Гранатомёт", "item.warfront.ammo": "Патроны",
    "item.warfront.rocket": "Ракета",
    "block.warfront.headquarters": "Штаб", "block.warfront.house": "Знак: Дом", "block.warfront.barracks": "Знак: Казарма",
    "block.warfront.farm": "Знак: Ферма", "block.warfront.workshop": "Знак: Мастерская", "block.warfront.armory": "Знак: Оружейная",
    "block.warfront.factory": "Знак: Танковый завод", "block.warfront.enemy_flag": "Вражеский флаг",
    "entity.warfront.soldier": "Солдат", "entity.warfront.tank": "Танк", "entity.warfront.bullet": "Пуля",
    "entity.warfront.rocket": "Ракета", "itemGroup.warfront": "Фронт",
    "key.warfront.fire": "Выстрел из танка", "key.warfront.map": "Карта генерала", "key.categories.warfront": "Фронт"}
en = {
    "item.warfront.tablet": "Command Tablet", "item.warfront.rifle": "Rifle", "item.warfront.smg": "Submachine Gun",
    "item.warfront.shotgun": "Shotgun", "item.warfront.rocket_launcher": "Rocket Launcher", "item.warfront.ammo": "Ammo",
    "item.warfront.rocket": "Rocket",
    "block.warfront.headquarters": "Headquarters", "block.warfront.house": "House Sign", "block.warfront.barracks": "Barracks Sign",
    "block.warfront.farm": "Farm Sign", "block.warfront.workshop": "Workshop Sign", "block.warfront.armory": "Armory Sign",
    "block.warfront.factory": "Tank Factory Sign", "block.warfront.enemy_flag": "Enemy Flag",
    "entity.warfront.soldier": "Soldier", "entity.warfront.tank": "Tank", "entity.warfront.bullet": "Bullet",
    "entity.warfront.rocket": "Rocket", "itemGroup.warfront": "Warfront",
    "key.warfront.fire": "Fire tank cannon", "key.warfront.map": "General's map", "key.categories.warfront": "Warfront"}
w(f'{A}/lang/ru_ru.json', ru)
w(f'{A}/lang/en_us.json', en)
print('assets generated')
