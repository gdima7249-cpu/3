package com.warfront.kingdom;

import net.minecraft.core.BlockPos;
import net.minecraft.network.FriendlyByteBuf;

import java.util.ArrayList;
import java.util.List;

/** Снимок королевства для экрана карты: передаётся с сервера клиенту. */
public class KingdomView {
    public static final int M_HQ = 0, M_BUILDING = 1, M_SOLDIER = 7, M_TANK = 8, M_ENEMY = 9,
            M_OUTPOST = 10, M_FREED = 11, M_ORDER = 12;

    public static final class Marker {
        public final int type, x, z, squad;

        public Marker(int type, int x, int z, int squad) {
            this.type = type;
            this.x = x;
            this.z = z;
            this.squad = squad;
        }
    }

    public int day, pop, cap, food, iron, ammo, soldiers, soldierCap, tanks, tankCap, raids, freed;
    public int[] squadSoldiers = new int[KingdomData.SQUADS + 1];
    public int[] squadTanks = new int[KingdomData.SQUADS + 1];
    public int[] squadOrder = new int[KingdomData.SQUADS + 1];
    public int[] buildings = new int[BuildingType.values().length];
    public BlockPos hq = BlockPos.ZERO;
    public final List<Marker> markers = new ArrayList<>();

    public void write(FriendlyByteBuf b) {
        b.writeVarInt(day);
        b.writeVarInt(pop);
        b.writeVarInt(cap);
        b.writeVarInt(food);
        b.writeVarInt(iron);
        b.writeVarInt(ammo);
        b.writeVarInt(soldiers);
        b.writeVarInt(soldierCap);
        b.writeVarInt(tanks);
        b.writeVarInt(tankCap);
        b.writeVarInt(raids);
        b.writeVarInt(freed);
        b.writeBlockPos(hq);
        for (int i = 0; i <= KingdomData.SQUADS; i++) {
            b.writeVarInt(squadSoldiers[i]);
            b.writeVarInt(squadTanks[i]);
            b.writeVarInt(squadOrder[i]);
        }
        for (int v : buildings) b.writeVarInt(v);
        b.writeVarInt(markers.size());
        for (Marker m : markers) {
            b.writeByte(m.type);
            b.writeInt(m.x);
            b.writeInt(m.z);
            b.writeByte(m.squad);
        }
    }

    public static KingdomView read(FriendlyByteBuf b) {
        KingdomView v = new KingdomView();
        v.day = b.readVarInt();
        v.pop = b.readVarInt();
        v.cap = b.readVarInt();
        v.food = b.readVarInt();
        v.iron = b.readVarInt();
        v.ammo = b.readVarInt();
        v.soldiers = b.readVarInt();
        v.soldierCap = b.readVarInt();
        v.tanks = b.readVarInt();
        v.tankCap = b.readVarInt();
        v.raids = b.readVarInt();
        v.freed = b.readVarInt();
        v.hq = b.readBlockPos();
        for (int i = 0; i <= KingdomData.SQUADS; i++) {
            v.squadSoldiers[i] = b.readVarInt();
            v.squadTanks[i] = b.readVarInt();
            v.squadOrder[i] = b.readVarInt();
        }
        for (int i = 0; i < v.buildings.length; i++) v.buildings[i] = b.readVarInt();
        int n = b.readVarInt();
        for (int i = 0; i < n; i++) {
            v.markers.add(new Marker(b.readByte(), b.readInt(), b.readInt(), b.readByte()));
        }
        return v;
    }
}
