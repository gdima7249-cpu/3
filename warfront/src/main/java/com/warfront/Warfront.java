package com.warfront;

import com.warfront.entity.SoldierEntity;
import com.warfront.entity.TankEntity;
import com.warfront.net.Net;
import net.minecraftforge.eventbus.api.IEventBus;
import net.minecraftforge.event.entity.EntityAttributeCreationEvent;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.fml.event.lifecycle.FMLCommonSetupEvent;
import net.minecraftforge.fml.javafmlmod.FMLJavaModLoadingContext;

@Mod(Warfront.ID)
public class Warfront {
    public static final String ID = "warfront";

    public Warfront() {
        IEventBus bus = FMLJavaModLoadingContext.get().getModEventBus();
        ModBlocks.BLOCKS.register(bus);
        ModItems.ITEMS.register(bus);
        ModEntities.ENTITIES.register(bus);
        ModTabs.TABS.register(bus);
        bus.addListener(this::commonSetup);
        bus.addListener(this::attributes);
    }

    private void commonSetup(FMLCommonSetupEvent event) {
        event.enqueueWork(Net::register);
    }

    private void attributes(EntityAttributeCreationEvent event) {
        event.put(ModEntities.SOLDIER.get(), SoldierEntity.createAttributes().build());
        event.put(ModEntities.TANK.get(), TankEntity.createTankAttributes().build());
    }
}
