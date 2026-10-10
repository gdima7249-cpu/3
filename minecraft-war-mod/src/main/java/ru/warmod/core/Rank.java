package ru.warmod.core;

/** Воинские звания. Чем выше звание, тем больше прав. */
public enum Rank {
    PRIVATE("Рядовой", 0),
    SERGEANT("Сержант", 1),
    OFFICER("Офицер", 2),
    GENERAL("Генерал", 3);

    public final String title;
    public final int level;

    Rank(String title, int level) {
        this.title = title;
        this.level = level;
    }

    public boolean atLeast(Rank other) {
        return level >= other.level;
    }

    /** Танки и тяжёлая техника: рядовым не доверяют. */
    public boolean canUseTechnique() {
        return atLeast(SERGEANT);
    }

    /** Командовать можно только теми, кто ниже званием; рядовые не командуют. */
    public boolean canCommand(Rank other) {
        return atLeast(SERGEANT) && level > other.level;
    }

    public boolean canAssignTasks() {
        return atLeast(SERGEANT);
    }

    /** Офицеры планируют операции и вооружают войска из казны. */
    public boolean canEquipTroops() {
        return atLeast(OFFICER);
    }

    /** Офицерам не обязательно лично идти в бой - они командуют. */
    public boolean mustFight() {
        return level < OFFICER.level;
    }

    public Rank next() {
        return this == GENERAL ? this : values()[ordinal() + 1];
    }

    public Rank prev() {
        return this == PRIVATE ? this : values()[ordinal() - 1];
    }

    public static Rank parse(String s) {
        if (s == null) return null;
        String t = s.trim().toLowerCase();
        for (Rank r : values()) {
            if (r.name().toLowerCase().equals(t) || r.title.toLowerCase().equals(t)) return r;
        }
        return null;
    }
}
