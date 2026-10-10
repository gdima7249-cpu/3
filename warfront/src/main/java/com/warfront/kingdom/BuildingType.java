package com.warfront.kingdom;

/**
 * Здания королевства. Как в Terraria: здание - это настоящая комната (стены, крыша, дверь, свет, кровать).
 * Блок-маркер ставится внутри комнаты, и она проверяется.
 */
public enum BuildingType {
    HOUSE("house", "Дом", true, 36, 1, 4, 0, 0, 0, 10,
            "Комната от 6x6, крыша, дверь, факел, кровать (1 кровать = 1 жилец, до 4)"),
    BARRACKS("barracks", "Казарма", true, 100, 2, 16, 0, 0, 0, 25,
            "Комната от 10x10, крыша, дверь, свет, от 2 кроватей (до 16 солдат)"),
    FARM("farm", "Ферма", false, 16, 0, 0, 8, 0, 0, 8,
            "Не менее 16 грядок (вспаханная земля) рядом с маркером"),
    WORKSHOP("workshop", "Мастерская", true, 36, 0, 0, 0, 5, 0, 20,
            "Комната от 6x6, крыша, дверь, свет. Даёт железо"),
    ARMORY("armory", "Оружейная", true, 36, 0, 0, 0, 0, 6, 20,
            "Комната от 6x6, крыша, дверь, свет. Даёт боеприпасы"),
    FACTORY("factory", "Танковый завод", true, 100, 0, 0, 0, 0, 0, 50,
            "Ангар от 10x10, крыша, дверь, свет. Позволяет строить танки");

    public final String id;
    public final String title;
    /** true - закрытая комната, false - открытое поле. */
    public final boolean room;
    /** Минимальная площадь: для комнаты - клеток пола, для фермы - грядок. */
    public final int minArea;
    public final int minBeds;
    public final int maxBeds;
    /** Производство за ход. */
    public final int food, iron, ammo;
    /** Цена в железе при покупке. */
    public final int price;
    public final String hint;

    BuildingType(String id, String title, boolean room, int minArea, int minBeds, int maxBeds,
                 int food, int iron, int ammo, int price, String hint) {
        this.id = id;
        this.title = title;
        this.room = room;
        this.minArea = minArea;
        this.minBeds = minBeds;
        this.maxBeds = maxBeds;
        this.food = food;
        this.iron = iron;
        this.ammo = ammo;
        this.price = price;
        this.hint = hint;
    }
}
