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
            // обзор базы сверху
            case 80 -> tp(p, 20, 192, 14, 0, 90);
            case 160 -> shot(p, "01_base_overview");
            // витрина всех блоков мода
            case 180 -> tp(p, -1, 150.4, 0.5, 180, 12);
            case 250 -> shot(p, "02_showcase_blocks");
            // армия: танки и солдаты
            case 270 -> tp(p, 6, 150.6, 21, 180, 7);
            case 340 -> shot(p, "03_army");
            // штаб вблизи
            case 360 -> tp(p, 1.5, 150.4, 6, 180, 6);
            case 430 -> shot(p, "04_headquarters");
            // дом снаружи (дверь на западной стене)
            case 450 -> tp(p, 13, 150.4, 23.5, -90, 6);
            case 520 -> shot(p, "05_house_outside");
            // дом внутри: кровать, свет
            case 540 -> tp(p, 25.5, 150.2, 24.5, 135, 18);
            case 610 -> shot(p, "06_house_inside");
            // казарма
            case 630 -> tp(p, 35.5, 151.5, -8, 0, 6);
            case 700 -> shot(p, "07_barracks");
            // ферма
            case 720 -> tp(p, 16.5, 152.5, -14, 0, 28);
            case 790 -> shot(p, "08_farm");
            // винтовка от первого и третьего лица
            case 810 -> tp(p, 8, 150.4, 18, 150, 4);
            case 880 -> shot(p, "09_rifle_first_person");
            case 890 -> shot(p, "CAM:third");
            case 950 -> shot(p, "10_third_person");
            case 960 -> shot(p, "CAM:first");
            // интерфейс: карта и вкладки
            case 990 -> shot(p, "UI:map");
            case 1070 -> shot(p, "11_map_army");
            case 1080 -> shot(p, "UI:build");
            case 1110 -> shot(p, "12_map_buildings");
            case 1120 -> shot(p, "UI:log");
            case 1150 -> shot(p, "13_map_log");
            case 1160 -> shot(p, "UI:close");
            case 1200 -> shot(p, "EXIT");
            default -> { }
        }
    }
}
