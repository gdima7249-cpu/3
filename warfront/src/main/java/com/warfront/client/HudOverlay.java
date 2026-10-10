package com.warfront.client;

import com.warfront.ModItems;
import com.warfront.net.HudPacket;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraftforge.client.gui.overlay.ForgeGui;
import net.minecraftforge.client.gui.overlay.IGuiOverlay;

/** Полоска ресурсов в углу экрана: население, еда, железо, боеприпасы, армия. Плюс баннер тревоги. */
public class HudOverlay implements IGuiOverlay {
    @Override
    public void render(ForgeGui gui, GuiGraphics g, float partialTick, int width, int height) {
        Minecraft mc = Minecraft.getInstance();
        HudPacket s = ClientState.hud;
        if (s == null || mc.options.hideGui || mc.player == null) return;
        Font font = mc.font;

        String[] values = {
                s.pop + "/" + s.cap,
                String.valueOf(s.food),
                String.valueOf(s.iron),
                String.valueOf(s.ammo),
                s.soldiers + "/" + s.soldierCap,
                s.tanks + "/" + s.tankCap};
        ItemStack[] icons = {new ItemStack(Items.RED_BED), new ItemStack(Items.BREAD), new ItemStack(Items.IRON_INGOT),
                new ItemStack(Items.GUNPOWDER), new ItemStack(Items.IRON_HELMET), new ItemStack(Items.IRON_BLOCK)};
        int[] colors = {
                s.pop >= s.cap ? 0xFFFF9090 : 0xFFFFFFFF,
                s.food < 20 ? 0xFFFF6060 : 0xFFFFFFFF, 0xFFFFFFFF,
                s.ammo < 15 ? 0xFFFF6060 : 0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF};

        int x = 6, y = 6;
        String day = "День " + s.day;
        int dayW = font.width(day) + 10;
        int total = dayW;
        for (String v : values) total += 22 + font.width(v) + 8;
        g.fill(x - 3, y - 3, x + total + 3, y + 22, 0x99000000);
        g.drawString(font, day, x, y + 4, 0xFFFFD84A);
        int cx = x + dayW;
        for (int i = 0; i < values.length; i++) {
            g.renderItem(icons[i], cx, y);
            g.drawString(font, values[i], cx + 19, y + 4, colors[i]);
            cx += 22 + font.width(values[i]) + 8;
        }

        renderNotes(g, font, width);
    }

    private void renderNotes(GuiGraphics g, Font font, int width) {
        long now = System.currentTimeMillis();
        ClientState.NOTES.removeIf(n -> n.expires < now);
        int w = 210;
        int x = width - w - 6;
        int y = 6;
        for (ClientState.Note n : ClientState.NOTES) {
            java.util.List<net.minecraft.util.FormattedCharSequence> lines =
                    font.split(net.minecraft.network.chat.Component.literal(n.text), w - 10);
            int count = Math.min(lines.size(), 4);
            int h = 14 + count * 10 + 4;
            int bg = n.kind == 1 ? 0xD0902020 : n.kind == 2 ? 0xD0805818 : 0xD0203040;
            int fade = (int) Math.min(255, (n.expires - now) / 4);
            if (fade < 255) bg = (bg & 0x00FFFFFF) | (Math.max(0, Math.min(0xD0, fade)) << 24);
            g.fill(x, y, x + w, y + h, bg);
            g.fill(x, y, x + 3, y + h, n.kind == 1 ? 0xFFFF5050 : n.kind == 2 ? 0xFFFFB040 : 0xFF50A0FF);
            g.drawString(font, n.title, x + 8, y + 3, 0xFFFFFFFF);
            for (int i = 0; i < count; i++) g.drawString(font, lines.get(i), x + 8, y + 14 + i * 10, 0xFFE0E0E0);
            y += h + 3;
        }
    }
}
