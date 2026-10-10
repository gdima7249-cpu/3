package com.warfront;

import com.mojang.brigadier.CommandDispatcher;
import com.warfront.kingdom.BuildingType;
import com.warfront.kingdom.KingdomData;
import com.warfront.kingdom.KingdomManager;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.item.ItemStack;
import net.minecraftforge.event.RegisterCommandsEvent;
import net.minecraftforge.event.TickEvent;
import net.minecraftforge.event.entity.player.PlayerEvent;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraftforge.fml.common.Mod;

@Mod.EventBusSubscriber(modid = Warfront.ID)
public final class ServerEvents {
    private static final String KIT_TAG = "warfront_kit";

    private ServerEvents() {
    }

    @SubscribeEvent
    public static void onLogin(PlayerEvent.PlayerLoggedInEvent event) {
        if (!(event.getEntity() instanceof ServerPlayer p)) return;
        if (p.getPersistentData().getBoolean(KIT_TAG)) return;
        p.getPersistentData().putBoolean(KIT_TAG, true);
        giveKit(p);
        p.sendSystemMessage(Component.literal("Ты - генерал. Поставь Штаб в любом месте - там вырастет твоё королевство. "
                + "Дома и казармы дают жильё, население растёт само. Командуй планшетом (ПКМ или клавиша M)."));
    }

    public static void giveKit(ServerPlayer p) {
        give(p, new ItemStack(ModItems.TABLET.get()));
        give(p, new ItemStack(ModItems.HQ.get()));
        give(p, new ItemStack(ModItems.BUILDINGS.get(BuildingType.HOUSE).get(), 8));
        give(p, new ItemStack(ModItems.BUILDINGS.get(BuildingType.BARRACKS).get(), 2));
        give(p, new ItemStack(ModItems.BUILDINGS.get(BuildingType.FARM).get(), 3));
        give(p, new ItemStack(ModItems.BUILDINGS.get(BuildingType.WORKSHOP).get(), 2));
        give(p, new ItemStack(ModItems.BUILDINGS.get(BuildingType.ARMORY).get(), 2));
        give(p, new ItemStack(ModItems.BUILDINGS.get(BuildingType.FACTORY).get(), 1));
        give(p, new ItemStack(ModItems.RIFLE.get()));
        give(p, new ItemStack(ModItems.SMG.get()));
        give(p, new ItemStack(ModItems.LAUNCHER.get()));
        give(p, new ItemStack(ModItems.AMMO.get(), 64));
        give(p, new ItemStack(ModItems.ROCKET.get(), 8));
    }

    private static void give(ServerPlayer p, ItemStack s) {
        if (!p.getInventory().add(s)) p.drop(s, false);
    }

    @SubscribeEvent
    public static void onServerTick(TickEvent.ServerTickEvent event) {
        if (event.phase != TickEvent.Phase.END) return;
        if (event.getServer().getTickCount() % 20 == 0) KingdomManager.tick(event.getServer());
    }

    @SubscribeEvent
    public static void onCommands(RegisterCommandsEvent event) {
        CommandDispatcher<CommandSourceStack> d = event.getDispatcher();
        d.register(Commands.literal("warfront")
                .then(Commands.literal("kit").executes(c -> {
                    giveKit(c.getSource().getPlayerOrException());
                    return 1;
                }))
                .then(Commands.literal("status").executes(c -> {
                    KingdomData k = KingdomData.get(c.getSource().getServer());
                    c.getSource().sendSuccess(() -> Component.literal(k.founded
                            ? "Население " + k.pop + "/" + k.capacity() + ", еда " + k.food + ", железо " + k.iron
                            + ", боеприпасы " + k.ammo + ", освобождено форпостов " + k.capturedOutposts
                            : "Королевство не основано: поставь Штаб."), false);
                    return 1;
                }))
                .then(Commands.literal("raid").requires(s -> s.hasPermission(2)).executes(c -> {
                    KingdomManager.raid(c.getSource().getServer().overworld(), KingdomData.get(c.getSource().getServer()));
                    return 1;
                }))
                .then(Commands.literal("outpost").requires(s -> s.hasPermission(2)).executes(c -> {
                    KingdomData k = KingdomData.get(c.getSource().getServer());
                    if (k.founded) KingdomManager.ensureOutposts(c.getSource().getServer().overworld(), k);
                    return 1;
                })));
    }
}
