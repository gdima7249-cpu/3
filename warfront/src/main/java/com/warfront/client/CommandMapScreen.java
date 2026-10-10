package com.warfront.client;

import com.mojang.blaze3d.platform.NativeImage;
import com.warfront.Warfront;
import com.warfront.entity.SoldierEntity;
import com.warfront.kingdom.BuildingType;
import com.warfront.kingdom.KingdomData;
import com.warfront.kingdom.KingdomView;
import com.warfront.net.ActionPacket;
import com.warfront.net.Net;
import com.warfront.net.OrderPacket;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.renderer.texture.DynamicTexture;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.ResourceLocation;

import java.util.ArrayList;
import java.util.List;

/**
 * Карта мира генерала: местность, постройки, отряды, вражеские форпосты.
 * ЛКМ по карте - отдать приказ выбранному отряду, ПКМ/СКМ + перетаскивание - двигать карту, колесо - масштаб.
 */
public class CommandMapScreen extends Screen {
    private static final ResourceLocation TEX = new ResourceLocation(Warfront.ID, "dynamic/command_map");
    private static final int PANEL = 156;
    private static final int[] SCALES = {1, 2, 4, 8, 16};
    private static final String[] ORDER_NAMES = {"", "Идти", "Атака", "Держать"};
    private static final int[] BUILDING_COLORS = {0xFFE0C070, 0xFF4F7BFF, 0xFF5DD65D, 0xFFFF9A3C, 0xFFE8503C, 0xFFB46CFF};

    private KingdomView view;
    private double centerX, centerZ;
    private int scaleIdx = 2;
    private int squad = 1;
    private int orderType = SoldierEntity.MOVE;
    private int texW, texH;
    private NativeImage image;
    private DynamicTexture texture;
    private boolean dirty = true;
    private int ticks;
    private final List<Button> squadButtons = new ArrayList<>();
    private final List<Button> orderButtons = new ArrayList<>();
    private boolean centered;

    public CommandMapScreen(KingdomView view) {
        super(Component.literal("Карта генерала"));
        this.view = view;
    }

    public void update(KingdomView v) {
        this.view = v;
    }

    private int scale() {
        return SCALES[scaleIdx];
    }

    @Override
    protected void init() {
        if (!centered) {
            centerX = view.hq.getX();
            centerZ = view.hq.getZ();
            centered = true;
        }
        releaseTexture();
        texW = Math.max(64, Math.min(1024, width - PANEL));
        texH = Math.max(64, Math.min(1024, height));
        image = new NativeImage(texW, texH, false);
        texture = new DynamicTexture(image);
        Minecraft.getInstance().getTextureManager().register(TEX, texture);
        dirty = true;

        squadButtons.clear();
        orderButtons.clear();
        int px = width - PANEL + 6;
        int y = 150;
        for (int i = 1; i <= KingdomData.SQUADS; i++) {
            final int s = i;
            Button b = Button.builder(Component.literal(String.valueOf(i)), btn -> {
                squad = s;
                refreshLabels();
            }).bounds(px + (i - 1) * 28, y, 26, 18).build();
            squadButtons.add(addRenderableWidget(b));
        }
        y += 24;
        for (int t = 1; t <= 3; t++) {
            final int type = t;
            Button b = Button.builder(Component.literal(ORDER_NAMES[t]), btn -> {
                orderType = type;
                refreshLabels();
            }).bounds(px + (t - 1) * 48, y, 46, 18).build();
            orderButtons.add(addRenderableWidget(b));
        }
        y += 52;
        addRenderableWidget(Button.builder(Component.literal("+1 боец"), btn ->
                Net.CHANNEL.sendToServer(new ActionPacket(ActionPacket.RECRUIT, squad, 1)))
                .bounds(px, y, 68, 18).build());
        addRenderableWidget(Button.builder(Component.literal("+5 бойцов"), btn ->
                Net.CHANNEL.sendToServer(new ActionPacket(ActionPacket.RECRUIT, squad, 5)))
                .bounds(px + 72, y, 72, 18).build());
        y += 22;
        addRenderableWidget(Button.builder(Component.literal("Построить танк"), btn ->
                Net.CHANNEL.sendToServer(new ActionPacket(ActionPacket.BUILD_TANK, squad, 0)))
                .bounds(px, y, 144, 18).build());
        y += 22;
        addRenderableWidget(Button.builder(Component.literal("К штабу"), btn -> {
            centerX = view.hq.getX();
            centerZ = view.hq.getZ();
            dirty = true;
        }).bounds(px, y, 70, 18).build());
        addRenderableWidget(Button.builder(Component.literal("Закрыть"), btn -> onClose())
                .bounds(px + 74, y, 70, 18).build());
        refreshLabels();
    }

    private void refreshLabels() {
        for (int i = 0; i < squadButtons.size(); i++) {
            squadButtons.get(i).setMessage(Component.literal(i + 1 == squad ? "[" + (i + 1) + "]" : String.valueOf(i + 1)));
        }
        for (int i = 0; i < orderButtons.size(); i++) {
            String n = ORDER_NAMES[i + 1];
            orderButtons.get(i).setMessage(Component.literal(i + 1 == orderType ? "[" + n + "]" : n));
        }
    }

    private void releaseTexture() {
        if (texture != null) {
            Minecraft.getInstance().getTextureManager().release(TEX);
            texture = null;
            image = null;
        }
    }

    @Override
    public void removed() {
        releaseTexture();
        super.removed();
    }

    @Override
    public boolean isPauseScreen() {
        return false;
    }

    // ---------- обновление ----------

    @Override
    public void tick() {
        super.tick();
        ticks++;
        if (ticks % 20 == 0) Net.CHANNEL.sendToServer(new ActionPacket(ActionPacket.SYNC, 0, 0));
        if (ticks % 40 == 1) dirty = true;
        if (dirty) redraw();
    }

    private void redraw() {
        dirty = false;
        Minecraft mc = Minecraft.getInstance();
        if (mc.level == null || image == null) return;
        int s = scale();
        int radius = Math.min(24, (Math.max(texW, texH) / 2 * s) / 16 + 2);
        TerrainCache.scan(mc.level, Math.floorDiv((int) centerX, 16), Math.floorDiv((int) centerZ, 16), radius, 80);
        for (int ty = 0; ty < texH; ty++) {
            int wz = (int) Math.floor(centerZ + (ty - texH / 2) * (double) s);
            for (int tx = 0; tx < texW; tx++) {
                int wx = (int) Math.floor(centerX + (tx - texW / 2) * (double) s);
                image.setPixelRGBA(tx, ty, TerrainCache.color(wx, wz));
            }
        }
        texture.upload();
    }

    // ---------- рисование ----------

    private int sx(double wx) {
        return (int) Math.floor((wx - centerX) / scale() + texW / 2.0);
    }

    private int sy(double wz) {
        return (int) Math.floor((wz - centerZ) / scale() + texH / 2.0);
    }

    private void box(GuiGraphics g, int x, int y, int r, int color) {
        if (x < -r || y < -r || x > texW + r || y > texH + r) return;
        g.fill(x - r - 1, y - r - 1, x + r + 2, y + r + 2, 0xFF000000);
        g.fill(x - r, y - r, x + r + 1, y + r + 1, color);
    }

    @Override
    public void render(GuiGraphics g, int mouseX, int mouseY, float partialTick) {
        g.fill(0, 0, width, height, 0xFF101015);
        if (texture != null) g.blit(TEX, 0, 0, 0, 0, texW, texH, texW, texH);

        int[] cx = new int[KingdomData.SQUADS + 1], cz = new int[KingdomData.SQUADS + 1], cn = new int[KingdomData.SQUADS + 1];
        for (KingdomView.Marker m : view.markers) {
            int x = sx(m.x), y = sy(m.z);
            switch (m.type) {
                case KingdomView.M_HQ -> {
                    box(g, x, y, 5, 0xFFFFD84A);
                    g.drawString(font, "ШТАБ", x - 11, y + 8, 0xFFFFFFFF);
                }
                case KingdomView.M_SOLDIER -> {
                    box(g, x, y, 1, 0xFF4CFF4C);
                    cx[m.squad] += m.x;
                    cz[m.squad] += m.z;
                    cn[m.squad]++;
                }
                case KingdomView.M_TANK -> {
                    box(g, x, y, 3, 0xFF2E9E2E);
                    g.drawString(font, "T" + m.squad, x + 5, y - 4, 0xFFFFFFFF);
                }
                case KingdomView.M_ENEMY -> box(g, x, y, 1, 0xFFFF3030);
                case KingdomView.M_OUTPOST -> {
                    box(g, x, y, 4, 0xFFD02020);
                    g.drawString(font, "Форпост", x - 18, y + 7, 0xFFFF8080);
                }
                case KingdomView.M_FREED -> {
                    box(g, x, y, 4, 0xFF40D0FF);
                    g.drawString(font, "Наш", x - 8, y + 7, 0xFF80E8FF);
                }
                case KingdomView.M_ORDER -> {
                    box(g, x, y, 3, 0xFFFFFFFF);
                    g.drawString(font, "->" + m.squad, x + 5, y - 4, 0xFFFFFF80);
                }
                default -> {
                    int idx = m.type - KingdomView.M_BUILDING;
                    if (idx >= 0 && idx < BUILDING_COLORS.length) box(g, x, y, 2, BUILDING_COLORS[idx]);
                }
            }
        }
        for (int s = 1; s <= KingdomData.SQUADS; s++) {
            if (cn[s] > 0) {
                int x = sx(cx[s] / (double) cn[s]), y = sy(cz[s] / (double) cn[s]);
                g.drawString(font, String.valueOf(s), x + 4, y - 10, s == squad ? 0xFFFFFF40 : 0xFFB0FFB0);
            }
        }

        // панель
        int px = width - PANEL;
        g.fill(px, 0, width, height, 0xE0181A20);
        int x = px + 6;
        int y = 6;
        g.drawString(font, "Генерал  |  День " + view.day, x, y, 0xFFFFD84A);
        y += 14;
        line(g, x, y, "Население", view.pop + " / " + view.cap, view.pop >= view.cap ? 0xFFFF9090 : 0xFFFFFFFF); y += 11;
        line(g, x, y, "Еда", String.valueOf(view.food), view.food < 20 ? 0xFFFF9090 : 0xFFFFFFFF); y += 11;
        line(g, x, y, "Железо", String.valueOf(view.iron), 0xFFFFFFFF); y += 11;
        line(g, x, y, "Боеприпасы", String.valueOf(view.ammo), 0xFFFFFFFF); y += 11;
        line(g, x, y, "Солдаты", view.soldiers + " / " + view.soldierCap, 0xFFFFFFFF); y += 11;
        line(g, x, y, "Танки", view.tanks + " / " + view.tankCap, 0xFFFFFFFF); y += 11;
        line(g, x, y, "Налётов", String.valueOf(view.raids), 0xFFFFFFFF); y += 11;
        line(g, x, y, "Освобождено", String.valueOf(view.freed), 0xFF80E8FF); y += 14;
        g.drawString(font, "Отряд / приказ:", x, 138, 0xFFB0B0B0);

        int info = 150 + 24 + 22;
        g.drawString(font, "Отряд " + squad + ": солдат " + view.squadSoldiers[squad] + ", танков "
                + view.squadTanks[squad], x, info, 0xFFFFFFFF);
        int ord = view.squadOrder[squad];
        g.drawString(font, "Приказ: " + (ord == 0 ? "нет" : ORDER_NAMES[ord]), x, info + 11, 0xFFE0E0A0);
        g.drawString(font, "ЛКМ по карте = приказ", x, info + 24, 0xFF909090);

        int hy = height - 52;
        String[] help = {"ПКМ/СКМ + тянуть: двигать", "Колесо: масштаб (" + scale() + " бл/пикс)",
                "1-5: выбор отряда, M: закрыть"};
        for (int i = 0; i < help.length; i++) g.drawString(font, help[i], x, hy + i * 11, 0xFF808080);

        // жильё и производство
        StringBuilder sb = new StringBuilder();
        for (BuildingType t : BuildingType.values()) {
            sb.append(t.title.charAt(0)).append(view.buildings[t.ordinal()]).append(' ');
        }
        g.drawString(font, sb.toString(), x, height - 66, 0xFFA0C0FF);

        super.render(g, mouseX, mouseY, partialTick);
    }

    private void line(GuiGraphics g, int x, int y, String label, String value, int color) {
        g.drawString(font, label + ":", x, y, 0xFFB0B0B0);
        g.drawString(font, value, x + 84, y, color);
    }

    // ---------- ввод ----------

    @Override
    public boolean mouseClicked(double mx, double my, int button) {
        if (super.mouseClicked(mx, my, button)) return true;
        if (button == 0 && mx < texW && my < texH) {
            int wx = (int) Math.floor(centerX + (mx - texW / 2.0) * scale());
            int wz = (int) Math.floor(centerZ + (my - texH / 2.0) * scale());
            Net.CHANNEL.sendToServer(new OrderPacket(squad, orderType, wx, wz));
            return true;
        }
        return false;
    }

    @Override
    public boolean mouseDragged(double mx, double my, int button, double dx, double dy) {
        if (button == 1 || button == 2) {
            centerX -= dx * scale();
            centerZ -= dy * scale();
            dirty = true;
            return true;
        }
        return super.mouseDragged(mx, my, button, dx, dy);
    }

    @Override
    public boolean mouseScrolled(double mx, double my, double delta) {
        int old = scaleIdx;
        scaleIdx = Math.max(0, Math.min(SCALES.length - 1, scaleIdx + (delta > 0 ? -1 : 1)));
        if (old != scaleIdx) dirty = true;
        return true;
    }

    @Override
    public boolean keyPressed(int key, int scan, int mods) {
        if (key >= 49 && key <= 53) {
            squad = key - 48;
            refreshLabels();
            return true;
        }
        if (key == ClientSetup.MAP.getKey().getValue()) {
            onClose();
            return true;
        }
        return super.keyPressed(key, scan, mods);
    }
}
