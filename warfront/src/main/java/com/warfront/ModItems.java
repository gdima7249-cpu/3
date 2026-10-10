package com.warfront;

import com.warfront.item.GunItem;
import com.warfront.item.TabletItem;
import com.warfront.kingdom.BuildingType;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.Item;
import net.minecraftforge.registries.DeferredRegister;
import net.minecraftforge.registries.ForgeRegistries;
import net.minecraftforge.registries.RegistryObject;

import java.util.EnumMap;
import java.util.Map;

public final class ModItems {
    public static final DeferredRegister<Item> ITEMS = DeferredRegister.create(ForgeRegistries.ITEMS, Warfront.ID);

    public static final RegistryObject<Item> TABLET = ITEMS.register("tablet",
            () -> new TabletItem(new Item.Properties().stacksTo(1)));

    public static final RegistryObject<Item> AMMO = ITEMS.register("ammo", () -> new Item(new Item.Properties()));
    public static final RegistryObject<Item> ROCKET = ITEMS.register("rocket", () -> new Item(new Item.Properties()));

    public static final RegistryObject<Item> RIFLE = ITEMS.register("rifle",
            () -> new GunItem(new Item.Properties().stacksTo(1), 9.0F, 12, false, 1, 0.8F, 3.5F, false));
    public static final RegistryObject<Item> SMG = ITEMS.register("smg",
            () -> new GunItem(new Item.Properties().stacksTo(1), 4.5F, 3, true, 1, 4.0F, 3.2F, false));
    public static final RegistryObject<Item> SHOTGUN = ITEMS.register("shotgun",
            () -> new GunItem(new Item.Properties().stacksTo(1), 5.0F, 25, false, 6, 9.0F, 2.8F, false));
    public static final RegistryObject<Item> LAUNCHER = ITEMS.register("rocket_launcher",
            () -> new GunItem(new Item.Properties().stacksTo(1), 14.0F, 50, false, 1, 0.5F, 2.2F, true));

    public static final RegistryObject<Item> HQ = ITEMS.register("headquarters",
            () -> new BlockItem(ModBlocks.HQ.get(), new Item.Properties()));
    public static final RegistryObject<Item> ENEMY_FLAG = ITEMS.register("enemy_flag",
            () -> new BlockItem(ModBlocks.ENEMY_FLAG.get(), new Item.Properties()));

    public static final Map<BuildingType, RegistryObject<Item>> BUILDINGS = new EnumMap<>(BuildingType.class);

    static {
        for (BuildingType t : BuildingType.values()) {
            BUILDINGS.put(t, ITEMS.register(t.id,
                    () -> new BlockItem(ModBlocks.BUILDINGS.get(t).get(), new Item.Properties())));
        }
    }

    private ModItems() {
    }
}
