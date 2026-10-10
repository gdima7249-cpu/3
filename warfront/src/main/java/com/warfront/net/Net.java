package com.warfront.net;

import com.warfront.Warfront;
import com.warfront.kingdom.KingdomManager;
import com.warfront.kingdom.KingdomView;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.level.ServerPlayer;
import net.minecraftforge.network.NetworkRegistry;
import net.minecraftforge.network.PacketDistributor;
import net.minecraftforge.network.simple.SimpleChannel;

public final class Net {
    private static final String PROTOCOL = "1";
    public static final SimpleChannel CHANNEL = NetworkRegistry.newSimpleChannel(
            new ResourceLocation(Warfront.ID, "main"), () -> PROTOCOL, PROTOCOL::equals, PROTOCOL::equals);

    private Net() {
    }

    public static void register() {
        int id = 0;
        CHANNEL.registerMessage(id++, SyncPacket.class, SyncPacket::encode, SyncPacket::decode, SyncPacket::handle);
        CHANNEL.registerMessage(id++, OrderPacket.class, OrderPacket::encode, OrderPacket::decode, OrderPacket::handle);
        CHANNEL.registerMessage(id++, ActionPacket.class, ActionPacket::encode, ActionPacket::decode, ActionPacket::handle);
        CHANNEL.registerMessage(id++, NotifyPacket.class, NotifyPacket::encode, NotifyPacket::decode, NotifyPacket::handle);
        CHANNEL.registerMessage(id++, HudPacket.class, HudPacket::encode, HudPacket::decode, HudPacket::handle);
    }

    /** Отправить игроку снимок королевства; open=true открывает экран карты. */
    public static void sendSync(ServerPlayer player, boolean open) {
        KingdomView view = KingdomManager.view(player.server);
        CHANNEL.send(PacketDistributor.PLAYER.with(() -> player), new SyncPacket(open, view));
    }
}
