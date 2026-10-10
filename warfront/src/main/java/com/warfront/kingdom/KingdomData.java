package com.warfront.kingdom;

import net.minecraft.core.BlockPos;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.nbt.Tag;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.level.saveddata.SavedData;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Всё состояние королевства игрока. Хранится в мире и переживает перезапуск. */
public class KingdomData extends SavedData {
    public static final String NAME = "warfront_kingdom";
    public static final int SQUADS = 5;

    public static final class Outpost {
        public BlockPos pos;
        public boolean discovered;
        public boolean captured;
        public int progress;
        public int level;

        public Outpost(BlockPos pos, int level) {
            this.pos = pos;
            this.level = level;
        }
    }

    public static final int TERRITORY_RADIUS = 64;

    /** Построенное здание и результат проверки его комнаты. */
    public static final class Building {
        public BuildingType type;
        public boolean valid;
        public int area, beds, capacity;
        public String text = "";
    }

    public boolean founded;
    public BlockPos hq = BlockPos.ZERO;
    public int pop;
    public int food, iron, ammo;
    public long lastTurn;
    public long nextRaid;
    public int raidsSurvived;
    public int capturedOutposts;
    public final Map<Long, Building> buildings = new LinkedHashMap<>();
    public final List<String> log = new ArrayList<>();
    public final List<Outpost> outposts = new ArrayList<>();
    /** Текущий приказ каждого отряда (индекс 1..5): тип и цель. */
    public final int[] squadOrder = new int[SQUADS + 1];
    public final long[] squadTarget = new long[SQUADS + 1];

    public static KingdomData get(MinecraftServer server) {
        return server.overworld().getDataStorage().computeIfAbsent(KingdomData::load, KingdomData::new, NAME);
    }

    /** Сколько рабочих (прошедших проверку) зданий данного типа. */
    public int count(BuildingType t) {
        int n = 0;
        for (Building b : buildings.values()) if (b.valid && b.type == t) n++;
        return n;
    }

    /** Вместимость жилья: места в кроватях рабочих домов и казарм, плюс палатки штаба и освобождённые форпосты. */
    public int capacity() {
        int cap = 4 + capturedOutposts * 10;
        for (Building b : buildings.values()) if (b.valid) cap += b.capacity;
        return cap;
    }

    public int soldierCap() {
        int cap = 4;
        for (Building b : buildings.values()) if (b.valid && b.type == BuildingType.BARRACKS) cap += b.capacity;
        return cap;
    }

    public int tankCap() {
        return count(BuildingType.FACTORY) * 2;
    }

    public boolean inTerritory(BlockPos p) {
        if (horizontal(p, hq) <= TERRITORY_RADIUS) return true;
        for (Outpost o : outposts) if (o.captured && horizontal(p, o.pos) <= TERRITORY_RADIUS * 3 / 4) return true;
        return false;
    }

    private static double horizontal(BlockPos a, BlockPos b) {
        double dx = a.getX() - b.getX(), dz = a.getZ() - b.getZ();
        return Math.sqrt(dx * dx + dz * dz);
    }

    public void addLog(String line) {
        log.add(line);
        while (log.size() > 40) log.remove(0);
    }

    public int uncapturedOutposts() {
        int n = 0;
        for (Outpost o : outposts) if (!o.captured) n++;
        return n;
    }

    @Override
    public CompoundTag save(CompoundTag tag) {
        tag.putBoolean("founded", founded);
        tag.putLong("hq", hq.asLong());
        tag.putInt("pop", pop);
        tag.putInt("food", food);
        tag.putInt("iron", iron);
        tag.putInt("ammo", ammo);
        tag.putLong("lastTurn", lastTurn);
        tag.putLong("nextRaid", nextRaid);
        tag.putInt("raids", raidsSurvived);
        tag.putInt("captured", capturedOutposts);
        ListTag bl = new ListTag();
        for (Map.Entry<Long, Building> e : buildings.entrySet()) {
            CompoundTag c = new CompoundTag();
            Building b = e.getValue();
            c.putLong("p", e.getKey());
            c.putInt("t", b.type.ordinal());
            c.putBoolean("v", b.valid);
            c.putInt("a", b.area);
            c.putInt("b", b.beds);
            c.putInt("c", b.capacity);
            c.putString("x", b.text);
            bl.add(c);
        }
        ListTag logs = new ListTag();
        for (String l : log) logs.add(net.minecraft.nbt.StringTag.valueOf(l));
        tag.put("log", logs);
        tag.put("buildings", bl);
        ListTag ol = new ListTag();
        for (Outpost o : outposts) {
            CompoundTag c = new CompoundTag();
            c.putLong("p", o.pos.asLong());
            c.putBoolean("d", o.discovered);
            c.putBoolean("c", o.captured);
            c.putInt("g", o.progress);
            c.putInt("l", o.level);
            ol.add(c);
        }
        tag.put("outposts", ol);
        tag.putIntArray("sOrder", squadOrder);
        long[] t = squadTarget.clone();
        tag.putLongArray("sTarget", t);
        return tag;
    }

    public static KingdomData load(CompoundTag tag) {
        KingdomData d = new KingdomData();
        d.founded = tag.getBoolean("founded");
        d.hq = BlockPos.of(tag.getLong("hq"));
        d.pop = tag.getInt("pop");
        d.food = tag.getInt("food");
        d.iron = tag.getInt("iron");
        d.ammo = tag.getInt("ammo");
        d.lastTurn = tag.getLong("lastTurn");
        d.nextRaid = tag.getLong("nextRaid");
        d.raidsSurvived = tag.getInt("raids");
        d.capturedOutposts = tag.getInt("captured");
        BuildingType[] types = BuildingType.values();
        for (Tag t : tag.getList("buildings", Tag.TAG_COMPOUND)) {
            CompoundTag c = (CompoundTag) t;
            int idx = c.getInt("t");
            if (idx >= 0 && idx < types.length) {
                Building b = new Building();
                b.type = types[idx];
                b.valid = c.getBoolean("v");
                b.area = c.getInt("a");
                b.beds = c.getInt("b");
                b.capacity = c.getInt("c");
                b.text = c.getString("x");
                d.buildings.put(c.getLong("p"), b);
            }
        }
        for (Tag t : tag.getList("log", Tag.TAG_STRING)) d.log.add(t.getAsString());
        for (Tag t : tag.getList("outposts", Tag.TAG_COMPOUND)) {
            CompoundTag c = (CompoundTag) t;
            Outpost o = new Outpost(BlockPos.of(c.getLong("p")), c.getInt("l"));
            o.discovered = c.getBoolean("d");
            o.captured = c.getBoolean("c");
            o.progress = c.getInt("g");
            d.outposts.add(o);
        }
        int[] so = tag.getIntArray("sOrder");
        for (int i = 0; i < so.length && i < d.squadOrder.length; i++) d.squadOrder[i] = so[i];
        long[] st = tag.getLongArray("sTarget");
        for (int i = 0; i < st.length && i < d.squadTarget.length; i++) d.squadTarget[i] = st[i];
        return d;
    }
}
