package com.warfront;

import net.minecraft.core.registries.Registries;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.tags.TagKey;
import net.minecraft.world.item.Item;

public final class ModTags {
    /** Оружие, которым могут пользоваться солдаты. Сюда можно добавить предметы из других модов. */
    public static final TagKey<Item> SOLDIER_WEAPONS =
            TagKey.create(Registries.ITEM, new ResourceLocation(Warfront.ID, "soldier_weapons"));

    private ModTags() {
    }
}
