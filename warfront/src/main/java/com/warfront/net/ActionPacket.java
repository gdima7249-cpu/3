package com.warfront.net;

import com.warfront.entity.TankEntity;
import com.warfront.kingdom.KingdomData;
import com.warfront.kingdom.KingdomManager;
import net.minecraft.network.FriendlyByteBuf;
import net.minecraft.server.level.ServerPlayer;
import net.minecraftforge.network.NetworkEvent;

import java.util.function.Supplier;

/** Простые действия игрока: обновить карту, открыть карту, нанять, построить танк, выстрелить. */
public class ActionPacket {
    public static final int SYNC = 0, OPEN = 1, RECRUIT = 2, BUILD_TANK = 3, FIRE = 4, BUY = 5;

    public final int action, a, b;

    public ActionPacket(int action, int a, int b) {
        this.action = action;
        this.a = a;
        this.b = b;
    }

    public static void encode(ActionPacket p, FriendlyByteBuf buf) {
        buf.writeVarInt(p.action);
        buf.writeVarInt(p.a);
        buf.writeVarInt(p.b);
    }

    public static ActionPacket decode(FriendlyByteBuf buf) {
        return new ActionPacket(buf.readVarInt(), buf.readVarInt(), buf.readVarInt());
    }

    public static void handle(ActionPacket p, Supplier<NetworkEvent.Context> ctx) {
        ctx.get().enqueueWork(() -> {
            ServerPlayer sender = ctx.get().getSender();
            if (sender == null) return;
            switch (p.action) {
                case SYNC -> Net.sendSync(sender, false);
                case OPEN -> {
                    if (KingdomData.get(sender.server).founded) Net.sendSync(sender, true);
                }
                case RECRUIT -> {
                    KingdomManager.recruit(sender, p.a, p.b);
                    Net.sendSync(sender, false);
                }
                case BUILD_TANK -> {
                    KingdomManager.buildTank(sender, p.a);
                    Net.sendSync(sender, false);
                }
                case BUY -> {
                    KingdomManager.buy(sender, p.a);
                    Net.sendSync(sender, false);
                }
                case FIRE -> {
                    if (sender.getVehicle() instanceof TankEntity tank && tank.getControllingPassenger() == sender) {
                        tank.fire(sender.getLookAngle());
                    }
                }
                default -> { }
            }
        });
        ctx.get().setPacketHandled(true);
    }
}
