package com.warfront.net;

import com.warfront.kingdom.KingdomManager;
import net.minecraft.network.FriendlyByteBuf;
import net.minecraft.server.level.ServerPlayer;
import net.minecraftforge.network.NetworkEvent;

import java.util.function.Supplier;

/** Приказ отряду: тип (1 идти, 2 атаковать, 3 держать) и точка на карте. */
public class OrderPacket {
    public final int squad, type, x, z;

    public OrderPacket(int squad, int type, int x, int z) {
        this.squad = squad;
        this.type = type;
        this.x = x;
        this.z = z;
    }

    public static void encode(OrderPacket p, FriendlyByteBuf buf) {
        buf.writeVarInt(p.squad);
        buf.writeVarInt(p.type);
        buf.writeInt(p.x);
        buf.writeInt(p.z);
    }

    public static OrderPacket decode(FriendlyByteBuf buf) {
        return new OrderPacket(buf.readVarInt(), buf.readVarInt(), buf.readInt(), buf.readInt());
    }

    public static void handle(OrderPacket p, Supplier<NetworkEvent.Context> ctx) {
        ctx.get().enqueueWork(() -> {
            ServerPlayer sender = ctx.get().getSender();
            if (sender != null) {
                KingdomManager.order(sender, p.squad, p.type, p.x, p.z);
                Net.sendSync(sender, false);
            }
        });
        ctx.get().setPacketHandled(true);
    }
}
