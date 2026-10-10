package com.warfront.net;

import com.warfront.client.ClientHooks;
import net.minecraft.network.FriendlyByteBuf;
import net.minecraftforge.api.distmarker.Dist;
import net.minecraftforge.fml.DistExecutor;
import net.minecraftforge.network.NetworkEvent;

import java.util.function.Supplier;

/** Всплывающее уведомление на клиенте. kind: 0 - обычное, 1 - тревога. */
public class NotifyPacket {
    public final String title, text;
    public final int kind;

    public NotifyPacket(String title, String text, int kind) {
        this.title = title;
        this.text = text;
        this.kind = kind;
    }

    public static void encode(NotifyPacket p, FriendlyByteBuf buf) {
        buf.writeUtf(p.title, 200);
        buf.writeUtf(p.text, 400);
        buf.writeVarInt(p.kind);
    }

    public static NotifyPacket decode(FriendlyByteBuf buf) {
        return new NotifyPacket(buf.readUtf(200), buf.readUtf(400), buf.readVarInt());
    }

    public static void handle(NotifyPacket p, Supplier<NetworkEvent.Context> ctx) {
        ctx.get().enqueueWork(() ->
                DistExecutor.unsafeRunWhenOn(Dist.CLIENT, () -> () -> ClientHooks.notify(p.title, p.text, p.kind)));
        ctx.get().setPacketHandled(true);
    }
}
