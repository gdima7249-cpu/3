package com.warfront;

import com.mojang.brigadier.CommandDispatcher;
import com.warfront.kingdom.BuildingType;
import com.warfront.kingdom.KingdomData;
import com.warfront.kingdom.KingdomManager;
import com.warfront.net.HudPacket;
import com.warfront.net.Net;
import net.minecraftforge.network.PacketDistributor;
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
        p.sendSystemMessage(Component.literal("Ты - генерал. Поставь Штаб - там вырастет королевство. Постройте комнаты "
                + "(стены, крыша, дверь, факел, кровать) и поставьте в них знак здания. Карта - клавиша M."));
    }

    public static void giveKit(ServerPlayer p) {
        give(p, new ItemStack(ModItems.TABLET.get()));
        give(p, new ItemStack(ModItems.HQ.get()));
        give(p, new ItemStack(ModItems.BUILDINGS.get(BuildingType.HOUSE).get(), 2));
        give(p, new ItemStack(ModItems.BUILDINGS.get(BuildingType.BARRACKS).get(), 1));
        give(p, new ItemStack(ModItems.BUILDINGS.get(BuildingType.FARM).get(), 1));
        give(p, new ItemStack(ModItems.BUILDINGS.get(BuildingType.WORKSHOP).get(), 1));
        give(p, new ItemStack(ModItems.BUILDINGS.get(BuildingType.ARMORY).get(), 1));
        give(p, new ItemStack(ModItems.BUILDINGS.get(BuildingType.FACTORY).get(), 1));
        give(p, new ItemStack(net.minecraft.world.item.Items.RED_BED, 6));
        give(p, new ItemStack(net.minecraft.world.item.Items.OAK_DOOR, 4));
        give(p, new ItemStack(net.minecraft.world.item.Items.TORCH, 16));
        give(p, new ItemStack(net.minecraft.world.item.Items.OAK_PLANKS, 64));
        give(p, new ItemStack(net.minecraft.world.item.Items.COBBLESTONE, 128));
        give(p, new ItemStack(net.minecraft.world.item.Items.IRON_HOE));
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
        int t = event.getServer().getTickCount();
        if (t % 20 == 0) KingdomManager.tick(event.getServer());
        if (t % 40 == 0 && KingdomData.get(event.getServer()).founded && !event.getServer().getPlayerList().getPlayers().isEmpty()) {
            HudPacket hud = KingdomManager.hud(event.getServer());
            Net.CHANNEL.send(PacketDistributor.ALL.noArg(), hud);
        }
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
                .then(Commands.literal("buildings").executes(c -> {
                    KingdomData k = KingdomData.get(c.getSource().getServer());
                    for (var e : k.buildings.entrySet()) {
                        var pos = net.minecraft.core.BlockPos.of(e.getKey());
                        var b = e.getValue();
                        c.getSource().sendSuccess(() -> Component.literal((b.valid ? "[OK] " : "[НЕТ] ") + b.type.title + " "
                                + pos.getX() + " " + pos.getY() + " " + pos.getZ() + ": " + b.text), false);
                    }
                    c.getSource().sendSuccess(() -> Component.literal("Зданий: " + k.buildings.size()), false);
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
