#!/usr/bin/env python3
"""Генерирует текстуры, модели, рецепты, языки и теги мода. Запуск: python3 tools/gen_assets.py"""
import json, os, random
from PIL import Image, ImageDraw

ROOT = os.path.join(os.path.dirname(__file__), '..', 'src', 'main', 'resources')
A = os.path.join(ROOT, 'assets', 'warfront')
D = os.path.join(ROOT, 'data', 'warfront')
random.seed(7)


def w(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        if isinstance(data, str):
            f.write(data)
        else:
            json.dump(data, f, ensure_ascii=False, indent=2)


def save(img, rel):
    p = os.path.join(A, 'textures', rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    img.save(p)


def noise(img, amt=14):
    px = img.load()
    for x in range(img.width):
        for y in range(img.height):
            r, g, b, a = px[x, y]
            d = random.randint(-amt, amt)
            px[x, y] = (max(0, min(255, r + d)), max(0, min(255, g + d)), max(0, min(255, b + d)), a)


# ---------- блоки ----------
def block(name, base, accent, kind):
    img = Image.new('RGBA', (16, 16), base + (255,))
    d = ImageDraw.Draw(img)
    if kind == 'bricks':
        for y in range(0, 16, 4):
            d.line([(0, y), (15, y)], fill=tuple(max(0, c - 35) for c in base) + (255,))
            off = 0 if (y // 4) % 2 == 0 else 4
            for x in range(off, 16, 8):
                d.line([(x, y), (x, y + 3)], fill=tuple(max(0, c - 35) for c in base) + (255,))
    elif kind == 'planks':
        for y in range(0, 16, 4):
            d.line([(0, y), (15, y)], fill=tuple(max(0, c - 40) for c in base) + (255,))
    elif kind == 'field':
        for x in range(0, 16, 3):
            d.line([(x, 0), (x, 15)], fill=tuple(max(0, c - 40) for c in base) + (255,))
    elif kind == 'plates':
        d.rectangle([1, 1, 14, 14], outline=tuple(max(0, c - 50) for c in base) + (255,))
        for p in [(2, 2), (13, 2), (2, 13), (13, 13)]:
            d.point(p, fill=accent + (255,))
    d.rectangle([0, 6, 15, 9], fill=accent + (255,))
    noise(img, 10)
    save(img, f'block/{name}.png')


block('headquarters', (150, 40, 40), (240, 200, 60), 'plates')
block('house', (170, 130, 80), (190, 60, 50), 'planks')
block('barracks', (110, 115, 105), (70, 130, 70), 'bricks')
block('farm', (95, 140, 60), (230, 200, 60), 'field')
block('workshop', (120, 120, 130), (235, 140, 40), 'plates')
block('armory', (110, 50, 50), (240, 210, 70), 'bricks')
block('factory', (70, 75, 90), (170, 100, 230), 'plates')
img = Image.new('RGBA', (16, 16), (20, 20, 22, 255))
d = ImageDraw.Draw(img)
d.line([(2, 2), (13, 13)], fill=(200, 30, 30, 255), width=2)
d.line([(13, 2), (2, 13)], fill=(200, 30, 30, 255), width=2)
save(img, 'block/enemy_flag.png')


# ---------- предметы ----------
def item(name, painter):
    img = Image.new('RGBA', (16, 16), (0, 0, 0, 0))
    painter(ImageDraw.Draw(img))
    save(img, f'item/{name}.png')


dark, gray, brown, gold, red = (40, 40, 45, 255), (130, 135, 140, 255), (110, 70, 35, 255), (240, 200, 60, 255), (200, 40, 40, 255)


def tablet(d):
    d.rectangle([3, 1, 12, 14], fill=dark, outline=(15, 15, 18, 255))
    d.rectangle([4, 2, 11, 12], fill=(40, 120, 70, 255))
    d.line([(5, 5), (10, 9)], fill=(255, 255, 255, 255))
    d.point((10, 5), fill=red)
    d.point((6, 10), fill=gold)


def rifle(d):
    d.line([(1, 12), (14, 4)], fill=dark, width=2)
    d.line([(1, 13), (6, 10)], fill=brown, width=2)
    d.line([(8, 7), (9, 11)], fill=dark)


def smg(d):
    d.rectangle([2, 6, 13, 9], fill=dark)
    d.rectangle([11, 8, 14, 9], fill=gray)
    d.rectangle([5, 9, 7, 14], fill=gray)
    d.rectangle([2, 9, 3, 11], fill=brown)


def shotgun(d):
    d.line([(1, 11), (14, 5)], fill=gray, width=2)
    d.line([(1, 12), (7, 9)], fill=brown, width=3)
    d.line([(1, 9), (13, 3)], fill=dark)


def launcher(d):
    d.rectangle([1, 5, 14, 8], fill=(85, 105, 70, 255), outline=dark)
    d.rectangle([13, 4, 15, 9], fill=gray)
    d.rectangle([5, 9, 7, 13], fill=dark)
    d.point((2, 6), fill=red)


def ammo(d):
    d.rectangle([4, 5, 11, 12], fill=(160, 125, 40, 255), outline=(90, 70, 20, 255))
    for x in (5, 7, 9):
        d.rectangle([x, 2, x + 1, 5], fill=gold)


def rocket(d):
    d.line([(3, 12), (12, 3)], fill=(90, 100, 80, 255), width=3)
    d.polygon([(12, 3), (15, 0), (13, 4)], fill=red)
    d.point((2, 13), fill=(240, 140, 40, 255))


for n, p in [('tablet', tablet), ('rifle', rifle), ('smg', smg), ('shotgun', shotgun),
             ('rocket_launcher', launcher), ('ammo', ammo), ('rocket', rocket)]:
    item(n, p)


# ---------- сущности ----------
def soldier(name, cloth, cloth2, skin):
    img = Image.new('RGBA', (64, 64), cloth + (255,))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, 31, 15], fill=skin + (255,))      # голова
    d.rectangle([8, 8, 15, 15], fill=skin + (255,))
    d.rectangle([10, 11, 11, 11], fill=(40, 40, 40, 255))  # глаза
    d.rectangle([13, 11, 14, 11], fill=(40, 40, 40, 255))
    d.rectangle([10, 14, 14, 14], fill=(120, 70, 60, 255))
    d.rectangle([16, 16, 39, 31], fill=cloth2 + (255,))  # торс
    d.rectangle([40, 16, 55, 31], fill=cloth + (255,))   # руки
    d.rectangle([0, 16, 15, 31], fill=cloth2 + (255,))   # ноги
    d.rectangle([16, 48, 47, 63], fill=cloth + (255,))
    noise(img, 12)
    save(img, f'entity/{name}.png')


soldier('soldier', (74, 100, 60), (58, 82, 48), (226, 178, 140))
soldier('soldier_enemy', (110, 60, 55), (86, 48, 44), (210, 160, 125))

tank = Image.new('RGBA', (128, 128), (84, 98, 58, 255))
d = ImageDraw.Draw(tank)
d.rectangle([0, 40, 127, 79], fill=(48, 50, 46, 255))   # гусеницы
for x in range(0, 128, 6):
    d.line([(x, 40), (x, 79)], fill=(30, 31, 29, 255))
d.rectangle([0, 80, 127, 127], fill=(96, 112, 66, 255))  # башня и ствол
d.rectangle([60, 80, 127, 110], fill=(58, 62, 54, 255))
noise(tank, 14)
save(tank, 'entity/tank.png')

# ---------- модели ----------
BUILD = ['headquarters', 'house', 'barracks', 'farm', 'workshop', 'armory', 'factory']
ALL_BLOCKS = BUILD + ['enemy_flag']
ITEMS = ['tablet', 'rifle', 'smg', 'shotgun', 'rocket_launcher', 'ammo', 'rocket']

for b in ALL_BLOCKS:
    w(f'{A}/blockstates/{b}.json', {"variants": {"": {"model": f"warfront:block/{b}"}}})
    w(f'{A}/models/block/{b}.json', {"parent": "minecraft:block/cube_all", "textures": {"all": f"warfront:block/{b}"}})
    w(f'{A}/models/item/{b}.json', {"parent": f"warfront:block/{b}"})
    if b != 'enemy_flag':
        w(f'{D}/loot_tables/blocks/{b}.json', {
            "type": "minecraft:block",
            "pools": [{"rolls": 1, "entries": [{"type": "minecraft:item", "name": f"warfront:{b}"}],
                       "conditions": [{"condition": "minecraft:survives_explosion"}]}]})
for i in ITEMS:
    parent = "minecraft:item/handheld" if i in ('rifle', 'smg', 'shotgun', 'rocket_launcher') else "minecraft:item/generated"
    w(f'{A}/models/item/{i}.json', {"parent": parent, "textures": {"layer0": f"warfront:item/{i}"}})

# ---------- рецепты ----------
def shaped(name, pattern, key, result, count=1):
    w(f'{D}/recipes/{name}.json', {
        "type": "minecraft:crafting_shaped", "category": "misc", "pattern": pattern,
        "key": {k: {"item": v} for k, v in key.items()},
        "result": {"item": f"warfront:{result}", "count": count}})


shaped('house', ["PPP", "PCP", "PPP"], {"P": "minecraft:oak_planks", "C": "minecraft:cobblestone"}, 'house', 2)
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

# ---------- теги: оружие, доступное солдатам (сюда можно добавлять оружие из других модов) ----------
opt = lambda i: {"id": i, "required": False}
w(f'{D}/tags/items/soldier_weapons.json', {"replace": False, "values": [
    "warfront:rifle", "warfront:smg", "warfront:shotgun", "warfront:rocket_launcher",
    opt("cgm:pistol"), opt("cgm:shotgun"), opt("cgm:rifle"), opt("cgm:assault_rifle"),
    opt("cgm:bazooka"), opt("cgm:mini_gun"), opt("cgm:grenade_launcher"),
    opt("tacz:modern_kinetic_gun"), opt("pointblank:m4a1"), opt("pointblank:ak47")]})

# ---------- языки ----------
names_ru = {
    "item.warfront.tablet": "Командирский планшет", "item.warfront.rifle": "Винтовка", "item.warfront.smg": "Пистолет-пулемёт",
    "item.warfront.shotgun": "Дробовик", "item.warfront.rocket_launcher": "Гранатомёт", "item.warfront.ammo": "Патроны",
    "item.warfront.rocket": "Ракета",
    "block.warfront.headquarters": "Штаб", "block.warfront.house": "Дом", "block.warfront.barracks": "Казарма",
    "block.warfront.farm": "Ферма", "block.warfront.workshop": "Мастерская", "block.warfront.armory": "Оружейная",
    "block.warfront.factory": "Танковый завод", "block.warfront.enemy_flag": "Вражеский флаг",
    "entity.warfront.soldier": "Солдат", "entity.warfront.tank": "Танк", "entity.warfront.bullet": "Пуля",
    "entity.warfront.rocket": "Ракета", "itemGroup.warfront": "Фронт",
    "key.warfront.fire": "Выстрел из танка", "key.warfront.map": "Карта генерала", "key.categories.warfront": "Фронт"}
names_en = {
    "item.warfront.tablet": "Command Tablet", "item.warfront.rifle": "Rifle", "item.warfront.smg": "Submachine Gun",
    "item.warfront.shotgun": "Shotgun", "item.warfront.rocket_launcher": "Rocket Launcher", "item.warfront.ammo": "Ammo",
    "item.warfront.rocket": "Rocket",
    "block.warfront.headquarters": "Headquarters", "block.warfront.house": "House", "block.warfront.barracks": "Barracks",
    "block.warfront.farm": "Farm", "block.warfront.workshop": "Workshop", "block.warfront.armory": "Armory",
    "block.warfront.factory": "Tank Factory", "block.warfront.enemy_flag": "Enemy Flag",
    "entity.warfront.soldier": "Soldier", "entity.warfront.tank": "Tank", "entity.warfront.bullet": "Bullet",
    "entity.warfront.rocket": "Rocket", "itemGroup.warfront": "Warfront",
    "key.warfront.fire": "Fire tank cannon", "key.warfront.map": "General's map", "key.categories.warfront": "Warfront"}
w(f'{A}/lang/ru_ru.json', names_ru)
w(f'{A}/lang/en_us.json', names_en)
print('assets generated')
