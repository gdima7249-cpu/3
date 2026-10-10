package com.warfront.kingdom;

/** Здания армии. Игрок ставит блоки сам, королевство их учитывает. */
public enum BuildingType {
    HOUSE("house", "Дом", 5, 0, 0, 0),
    BARRACKS("barracks", "Казарма", 8, 0, 0, 0),
    FARM("farm", "Ферма", 0, 8, 0, 0),
    WORKSHOP("workshop", "Мастерская", 0, 0, 5, 0),
    ARMORY("armory", "Оружейная", 0, 0, 0, 6),
    FACTORY("factory", "Танковый завод", 0, 0, 0, 0);

    public final String id;
    public final String title;
    /** Сколько людей вмещает здание. */
    public final int housing;
    /** Производство за ход. */
    public final int food, iron, ammo;

    BuildingType(String id, String title, int housing, int food, int iron, int ammo) {
        this.id = id;
        this.title = title;
        this.housing = housing;
        this.food = food;
        this.iron = iron;
        this.ammo = ammo;
    }
}
