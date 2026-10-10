package com.warfront;

import net.minecraft.core.registries.Registries;
import net.minecraft.network.chat.Component;
import net.minecraft.world.item.CreativeModeTab;
import net.minecraft.world.item.ItemStack;
import net.minecraftforge.registries.DeferredRegister;
import net.minecraftforge.registries.RegistryObject;

public final class ModTabs {
    public static final DeferredRegister<CreativeModeTab> TABS =
            DeferredRegister.create(Registries.CREATIVE_MODE_TAB, Warfront.ID);

    public static final RegistryObject<CreativeModeTab> MAIN = TABS.register("main",
            () -> CreativeModeTab.builder()
                    .title(Component.translatable("itemGroup.warfront"))
                    .icon(() -> new ItemStack(ModItems.TABLET.get()))
                    .displayItems((params, out) -> {
                        out.accept(ModItems.TABLET.get());
                        out.accept(ModItems.HQ.get());
                        ModItems.BUILDINGS.values().forEach(r -> out.accept(r.get()));
                        out.accept(ModItems.RIFLE.get());
                        out.accept(ModItems.SMG.get());
                        out.accept(ModItems.SHOTGUN.get());
                        out.accept(ModItems.LAUNCHER.get());
                        out.accept(ModItems.AMMO.get());
                        out.accept(ModItems.ROCKET.get());
                    })
                    .build());

    private ModTabs() {
    }
}
