package com.warfront.net;

import com.warfront.client.ClientHooks;
import com.warfront.kingdom.KingdomView;
import net.minecraft.network.FriendlyByteBuf;
import net.minecraftforge.api.distmarker.Dist;
import net.minecraftforge.fml.DistExecutor;
import net.minecraftforge.network.NetworkEvent;

import java.util.function.Supplier;

public class SyncPacket {
    public final boolean open;
    public final KingdomView view;

    public SyncPacket(boolean open, KingdomView view) {
        this.open = open;
        this.view = view;
    }

    public static void encode(SyncPacket p, FriendlyByteBuf buf) {
        buf.writeBoolean(p.open);
        p.view.write(buf);
    }

    public static SyncPacket decode(FriendlyByteBuf buf) {
        return new SyncPacket(buf.readBoolean(), KingdomView.read(buf));
    }

    public static void handle(SyncPacket p, Supplier<NetworkEvent.Context> ctx) {
        ctx.get().enqueueWork(() ->
                DistExecutor.unsafeRunWhenOn(Dist.CLIENT, () -> () -> ClientHooks.onSync(p.open, p.view)));
        ctx.get().setPacketHandled(true);
    }
}
