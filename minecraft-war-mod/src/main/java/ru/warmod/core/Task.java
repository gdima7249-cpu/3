package ru.warmod.core;

import java.util.Random;

/** Задание для солдата: выдаётся автоматически или назначается командиром. */
public final class Task {
    public enum Type {
        KILL_ENEMY("Уничтожить вражеских солдат"),
        MINE_ORE("Добыть руду для армии"),
        KILL_MOBS("Зачистить территорию от монстров"),
        HEAL("Вылечить раненых бойцов аптечками"),
        CUSTOM("Приказ командира");

        public final String title;

        Type(String title) {
            this.title = title;
        }
    }

    public Type type;
    public int target;
    public int progress;
    public long reward;
    public String description;
    public String assignedBy;

    public static Task custom(String by, long reward, String text) {
        Task t = new Task();
        t.type = Type.CUSTOM;
        t.target = 1;
        t.reward = reward;
        t.description = text;
        t.assignedBy = by;
        return t;
    }

    /** Чем выше звание, тем крупнее и выгоднее задания. */
    public static Task generate(Rank rank, Random r) {
        Type[] pool = {Type.KILL_ENEMY, Type.MINE_ORE, Type.KILL_MOBS, Type.HEAL};
        Type type = pool[r.nextInt(pool.length)];
        int scale = 1 + rank.level;
        Task t = new Task();
        t.type = type;
        t.assignedBy = "штаб";
        switch (type) {
            case KILL_ENEMY -> { t.target = 2 + scale; t.reward = 30L * t.target; }
            case MINE_ORE -> { t.target = 12 * scale; t.reward = 4L * t.target; }
            case KILL_MOBS -> { t.target = 8 * scale; t.reward = 5L * t.target; }
            case HEAL -> { t.target = 2 + scale; t.reward = 20L * t.target; }
            default -> throw new IllegalStateException();
        }
        t.description = type.title + " (" + t.target + ")";
        return t;
    }

    public boolean done() {
        return progress >= target;
    }
}
