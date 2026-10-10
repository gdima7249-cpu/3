package com.warfront.net;

import com.warfront.client.ClientHooks;
import net.minecraft.network.FriendlyByteBuf;
import net.minecraftforge.api.distmarker.Dist;
import net.minecraftforge.fml.DistExecutor;
import net.minecraftforge.network.NetworkEvent;

import java.util.function.Supplier;

/** Данные для полоски ресурсов на экране. */
public class HudPacket {
    public final int day, pop, cap, food, iron, ammo, soldiers, soldierCap, tanks, tankCap;

    public HudPacket(int day, int pop, int cap, int food, int iron, int ammo, int soldiers, int soldierCap,
                     int tanks, int tankCap) {
        this.day = day;
        this.pop = pop;
        this.cap = cap;
        this.food = food;
        this.iron = iron;
        this.ammo = ammo;
        this.soldiers = soldiers;
        this.soldierCap = soldierCap;
        this.tanks = tanks;
        this.tankCap = tankCap;
    }

    public static void encode(HudPacket p, FriendlyByteBuf b) {
        b.writeVarInt(p.day);
        b.writeVarInt(p.pop);
        b.writeVarInt(p.cap);
        b.writeVarInt(p.food);
        b.writeVarInt(p.iron);
        b.writeVarInt(p.ammo);
        b.writeVarInt(p.soldiers);
        b.writeVarInt(p.soldierCap);
        b.writeVarInt(p.tanks);
        b.writeVarInt(p.tankCap);
    }

    public static HudPacket decode(FriendlyByteBuf b) {
        return new HudPacket(b.readVarInt(), b.readVarInt(), b.readVarInt(), b.readVarInt(), b.readVarInt(),
                b.readVarInt(), b.readVarInt(), b.readVarInt(), b.readVarInt(), b.readVarInt());
    }

    public static void handle(HudPacket p, Supplier<NetworkEvent.Context> ctx) {
        ctx.get().enqueueWork(() ->
                DistExecutor.unsafeRunWhenOn(Dist.CLIENT, () -> () -> ClientHooks.hud(p)));
        ctx.get().setPacketHandled(true);
    }
}
