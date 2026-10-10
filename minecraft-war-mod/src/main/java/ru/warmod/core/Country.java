package ru.warmod.core;

import java.time.Instant;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

public final class Country {
    public String name;
    /** Название цвета баннера в верхнем регистре, например RED. */
    public String color = "RED";
    /** Владелец государства (основатель или преемник). У ИИ-стран нет владельца. */
    public UUID leader;
    public boolean ai;
    /** Сила ИИ-страны: растёт со временем, определяет гарнизон и налёты. */
    public int strength;
    public long treasury;
    public String world;
    public int x, y, z;
    public long createdAt;
    /** До этого времени флаг захватить нельзя (защита новичков). */
    public long shieldUntil;
    public int conquests;
    public Map<UUID, Member> members = new LinkedHashMap<>();
    /** Очки: "all", "y:2026", "m:2026-10". */
    public Map<String, Long> score = new LinkedHashMap<>();

    public Country() {
    }

    public String key() {
        return WarState.key(name);
    }

    public int size() {
        return members.size();
    }

    public Member member(UUID id) {
        return members.get(id);
    }

    public Member leaderMember() {
        return leader == null ? null : members.get(leader);
    }

    public void addScore(long points, long nowMs) {
        if (points <= 0) return;
        ZonedDateTime t = Instant.ofEpochMilli(nowMs).atZone(ZoneOffset.UTC);
        score.merge("all", points, Long::sum);
        score.merge("y:" + t.getYear(), points, Long::sum);
        score.merge(String.format("m:%d-%02d", t.getYear(), t.getMonthValue()), points, Long::sum);
    }

    public static String monthKey(long nowMs) {
        ZonedDateTime t = Instant.ofEpochMilli(nowMs).atZone(ZoneOffset.UTC);
        return String.format("m:%d-%02d", t.getYear(), t.getMonthValue());
    }

    public static String yearKey(long nowMs) {
        return "y:" + Instant.ofEpochMilli(nowMs).atZone(ZoneOffset.UTC).getYear();
    }

    public long scoreOf(String key) {
        return score.getOrDefault(key, 0L);
    }
}
