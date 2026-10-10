package com.warfront.debug;

import com.warfront.Warfront;
import com.warfront.net.Net;
import com.warfront.net.NotifyPacket;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraftforge.event.TickEvent;
import net.minecraftforge.event.entity.player.PlayerEvent;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.network.PacketDistributor;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/**
 * Только для CI (включается свойством -Dwarfront.autotest=true): ведёт игрока по заранее построенной базе
 * и просит клиент делать скриншоты, чтобы проверить внешний вид мода.
 */
@Mod.EventBusSubscriber(modid = Warfront.ID)
public final class AutoTest {
    private static final boolean ON = System.getProperty("warfront.autotest") != null;
    private static final Map<UUID, Integer> CLOCK = new HashMap<>();

    private AutoTest() {
    }

    @SubscribeEvent
    public static void onLogin(PlayerEvent.PlayerLoggedInEvent event) {
        if (ON && event.getEntity() instanceof ServerPlayer p) CLOCK.put(p.getUUID(), 0);
    }

    private static void tp(ServerPlayer p, double x, double y, double z, float yaw, float pitch) {
        p.teleportTo((ServerLevel) p.level(), x, y, z, yaw, pitch);
    }

    private static void shot(ServerPlayer p, String name) {
        Net.CHANNEL.send(PacketDistributor.PLAYER.with(() -> p), new NotifyPacket("SHOT", name, 99));
    }

    @SubscribeEvent
    public static void onTick(TickEvent.PlayerTickEvent event) {
        if (!ON || event.phase != TickEvent.Phase.END || !(event.player instanceof ServerPlayer p)) return;
        Integer t0 = CLOCK.get(p.getUUID());
        if (t0 == null) return;
        int t = t0 + 1;
        CLOCK.put(p.getUUID(), t);
        ServerLevel level = (ServerLevel) p.level();
        switch (t) {
            case 40 -> {
                level.setDayTime(2000);
                p.getAbilities().flying = true;
                p.getAbilities().mayfly = true;
                p.onUpdateAbilities();
                p.setItemSlot(net.minecraft.world.entity.EquipmentSlot.MAINHAND,
                        new net.minecraft.world.item.ItemStack(com.warfront.ModItems.RIFLE.get()));
            }
            // обзор базы сверху: штаб, комнаты, солдаты, танк
            case 100 -> tp(p, 14, 158, -20, 0, 28);
            case 180 -> shot(p, "01_base_overview");
            // танк и солдаты вблизи
            case 220 -> tp(p, 4, 151.2, 12, 180, 8);
            case 300 -> shot(p, "02_tank_soldiers_front");
            case 330 -> tp(p, -3, 151.5, -2, -50, 6);
            case 400 -> shot(p, "03_hq_closeup");
            // комнаты: дом и казарма снаружи
            case 430 -> tp(p, 24, 153, 14, 0, 16);
            case 500 -> shot(p, "04_house_outside");
            // внутри дома: кровать, дверь, свет
            case 520 -> tp(p, 22.5, 150.1, 21.5, 160, 20);
            case 590 -> shot(p, "05_house_inside");
            // винтовка в руке от первого лица
            case 610 -> tp(p, 10, 150.1, 8, 20, 4);
            case 670 -> shot(p, "06_rifle_first_person");
            case 680 -> shot(p, "CAM:third");
            case 740 -> shot(p, "07_third_person");
            case 750 -> shot(p, "CAM:first");
            // интерфейс: карта и вкладки
            case 780 -> shot(p, "UI:map");
            case 860 -> shot(p, "08_map_army");
            case 870 -> shot(p, "UI:build");
            case 900 -> shot(p, "09_map_buildings");
            case 910 -> shot(p, "UI:log");
            case 940 -> shot(p, "10_map_log");
            case 950 -> shot(p, "UI:close");
            case 1000 -> shot(p, "EXIT");
            default -> { }
        }
    }
}
