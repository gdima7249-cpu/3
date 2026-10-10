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

    public boolean founded;
    public BlockPos hq = BlockPos.ZERO;
    public int pop;
    public int food, iron, ammo;
    public long lastTurn;
    public long nextRaid;
    public int raidsSurvived;
    public int capturedOutposts;
    public final Map<Long, BuildingType> buildings = new LinkedHashMap<>();
    public final List<Outpost> outposts = new ArrayList<>();
    /** Текущий приказ каждого отряда (индекс 1..5): тип и цель. */
    public final int[] squadOrder = new int[SQUADS + 1];
    public final long[] squadTarget = new long[SQUADS + 1];

    public static KingdomData get(MinecraftServer server) {
        return server.overworld().getDataStorage().computeIfAbsent(KingdomData::load, KingdomData::new, NAME);
    }

    public int count(BuildingType t) {
        int n = 0;
        for (BuildingType b : buildings.values()) if (b == t) n++;
        return n;
    }

    /** Вместимость жилья: штаб + дома + казармы + освобождённые форпосты. */
    public int capacity() {
        int cap = 6 + capturedOutposts * 10;
        for (BuildingType b : buildings.values()) cap += b.housing;
        return cap;
    }

    public int soldierCap() {
        return 8 + count(BuildingType.BARRACKS) * 10;
    }

    public int tankCap() {
        return count(BuildingType.FACTORY) * 2;
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
        for (Map.Entry<Long, BuildingType> e : buildings.entrySet()) {
            CompoundTag c = new CompoundTag();
            c.putLong("p", e.getKey());
            c.putInt("t", e.getValue().ordinal());
            bl.add(c);
        }
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
            if (idx >= 0 && idx < types.length) d.buildings.put(c.getLong("p"), types[idx]);
        }
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
