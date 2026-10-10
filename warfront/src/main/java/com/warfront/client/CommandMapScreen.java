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
import net.minecraft.util.FormattedCharSequence;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;

import java.util.ArrayList;
import java.util.List;

/**
 * Карта мира генерала. Вкладки справа: Армия (отряды, приказы, найм), Здания (покупка и проверка комнат), Журнал.
 * ЛКМ по карте - приказ выбранному отряду. ПКМ/СКМ + перетаскивание - двигать карту, колесо - масштаб.
 */
public class CommandMapScreen extends Screen {
    private enum Tab {
        ARMY("Армия"), BUILD("Здания"), LOG("Журнал");

        final String title;

        Tab(String title) {
            this.title = title;
        }
    }

    private static final ResourceLocation TEX = new ResourceLocation(Warfront.ID, "dynamic/command_map");
    private static final int PANEL = 204;
    private static final int[] SCALES = {1, 2, 4, 8, 16};
    private static final String[] ORDER_NAMES = {"", "Идти", "Атака", "Держать"};
    private static final int[] BUILDING_COLORS = {0xFFE0C070, 0xFF4F7BFF, 0xFF5DD65D, 0xFFFF9A3C, 0xFFE8503C, 0xFFB46CFF};

    private KingdomView view;
    private Tab tab = Tab.ARMY;
    private double centerX, centerZ;
    private int scaleIdx = 1;
    private int squad = 1;
    private int orderType = SoldierEntity.MOVE;
    private int texW, texH;
    private NativeImage image;
    private DynamicTexture texture;
    private boolean dirty = true;
    private int ticks;
    private boolean centered;
    private int listScroll;
    private int selectedBuilding = -1;
    // раскладка правой панели (зависит от высоты экрана)
    private int bh, lySquadLbl, lySquad, lyOrderLbl, lyOrder, lyInfo, lyRecruit, lyTank, lyList, lyKit;
    private final List<Button> squadButtons = new ArrayList<>();
    private final List<Button> orderButtons = new ArrayList<>();
    private final List<Button> buyButtons = new ArrayList<>();
    private final List<String> buyHints = new ArrayList<>();

    public CommandMapScreen(KingdomView view) {
        super(Component.literal("Карта генерала"));
        this.view = view;
    }

    /** Для автотеста CI: переключить вкладку. */
    public void debugTab(int index) {
        tab = Tab.values()[index];
        rebuildWidgets();
    }

    public void update(KingdomView v) {
        this.view = v;
    }

    private int scale() {
        return SCALES[scaleIdx];
    }

    private int panelX() {
        return width - PANEL;
    }

    // ---------- построение ----------

    @Override
    protected void init() {
        if (!centered) {
            centerX = view.hq.getX();
            centerZ = view.hq.getZ();
            centered = true;
        }
        ensureTexture();
        squadButtons.clear();
        orderButtons.clear();
        buyButtons.clear();
        buyHints.clear();

        int px = panelX() + 8;
        Tab[] tabs = Tab.values();
        for (int i = 0; i < tabs.length; i++) {
            final Tab t = tabs[i];
            Button b = Button.builder(Component.literal(t == tab ? "[" + t.title + "]" : t.title), btn -> {
                tab = t;
                rebuildWidgets();
            }).bounds(px + i * 62, 5, 60, bh).build();
            addRenderableWidget(b);
        }

        layout();
        int bottom = height - bh - 6;
        addRenderableWidget(Button.builder(Component.literal("К штабу"), btn -> {
            centerX = view.hq.getX();
            centerZ = view.hq.getZ();
            dirty = true;
        }).bounds(px, bottom, 88, bh).build());
        addRenderableWidget(Button.builder(Component.literal("Закрыть"), btn -> onClose())
                .bounds(px + 94, bottom, 94, bh).build());

        if (tab == Tab.ARMY) buildArmy(px);
        else if (tab == Tab.BUILD) buildShop(px);
    }

    /** Раскладка рассчитана на малую высоту экрана (около 240 пикселей интерфейса). */
    private void layout() {
        bh = height < 300 ? 16 : 18;
        lySquadLbl = 76;
        lySquad = lySquadLbl + 10;
        lyOrderLbl = lySquad + bh + 4;
        lyOrder = lyOrderLbl + 10;
        lyInfo = lyOrder + bh + 6;
        lyRecruit = lyInfo + 25;
        lyTank = lyRecruit + bh + 3;
        lyKit = 28 + 3 * (bh + 2);
        lyList = lyKit + bh + 16;
    }

    private void buildArmy(int px) {
        layout();
        for (int i = 1; i <= KingdomData.SQUADS; i++) {
            final int sq = i;
            squadButtons.add(addRenderableWidget(Button.builder(Component.literal(String.valueOf(i)), btn -> {
                squad = sq;
                rebuildWidgets();
            }).bounds(px + (i - 1) * 38, lySquad, 36, bh).build()));
        }
        for (int t = 1; t <= 3; t++) {
            final int type = t;
            orderButtons.add(addRenderableWidget(Button.builder(Component.literal(ORDER_NAMES[t]), btn -> {
                orderType = type;
                rebuildWidgets();
            }).bounds(px + (t - 1) * 63, lyOrder, 61, bh).build()));
        }
        addRenderableWidget(Button.builder(Component.literal("+1 боец"), btn ->
                Net.CHANNEL.sendToServer(new ActionPacket(ActionPacket.RECRUIT, squad, 1)))
                .bounds(px, lyRecruit, 92, bh).build());
        addRenderableWidget(Button.builder(Component.literal("+5 бойцов"), btn ->
                Net.CHANNEL.sendToServer(new ActionPacket(ActionPacket.RECRUIT, squad, 5)))
                .bounds(px + 96, lyRecruit, 92, bh).build());
        addRenderableWidget(Button.builder(Component.literal("Построить танк"), btn ->
                Net.CHANNEL.sendToServer(new ActionPacket(ActionPacket.BUILD_TANK, squad, 0)))
                .bounds(px, lyTank, 188, bh).build());
        updateLabels();
    }

    private void updateLabels() {
        for (int i = 0; i < squadButtons.size(); i++) {
            squadButtons.get(i).setMessage(Component.literal(i + 1 == squad ? "[" + (i + 1) + "]" : String.valueOf(i + 1)));
        }
        for (int i = 0; i < orderButtons.size(); i++) {
            String n = ORDER_NAMES[i + 1];
            orderButtons.get(i).setMessage(Component.literal(i + 1 == orderType ? "[" + n + "]" : n));
        }
    }

    private void buildShop(int px) {
        layout();
        BuildingType[] types = BuildingType.values();
        for (int i = 0; i < types.length; i++) {
            final int idx = i;
            BuildingType t = types[i];
            int bx = px + (i % 2) * 96;
            int by = 28 + (i / 2) * (bh + 2);
            buyButtons.add(addRenderableWidget(Button.builder(Component.literal(t.title + " " + t.price), btn ->
                    Net.CHANNEL.sendToServer(new ActionPacket(ActionPacket.BUY, idx, 0)))
                    .bounds(bx, by, 92, bh).build()));
            buyHints.add(t.title + " - " + t.price + " железа. " + t.hint);
        }
        buyButtons.add(addRenderableWidget(Button.builder(Component.literal("Набор мебели  10"), btn ->
                Net.CHANNEL.sendToServer(new ActionPacket(ActionPacket.BUY, types.length, 0)))
                .bounds(px, lyKit, 188, bh).build()));
        buyHints.add("Набор мебели - 10 железа: 2 кровати, дверь, 4 факела");
    }

    private void ensureTexture() {
        int w = Math.max(64, Math.min(1024, width - PANEL));
        int h = Math.max(64, Math.min(1024, height));
        if (texture != null && w == texW && h == texH) return;
        releaseTexture();
        texW = w;
        texH = h;
        image = new NativeImage(texW, texH, false);
        texture = new DynamicTexture(image);
        Minecraft.getInstance().getTextureManager().register(TEX, texture);
        dirty = true;
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
        if (ticks % 40 == 1 || (ticks <= 60 && ticks % 5 == 0)) dirty = true;
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
        renderMarkers(g);
        renderPanel(g);
        super.render(g, mouseX, mouseY, partialTick);
        if (tab == Tab.BUILD) {
            for (int i = 0; i < buyButtons.size(); i++) {
                if (buyButtons.get(i).isMouseOver(mouseX, mouseY)) {
                    List<FormattedCharSequence> lines = font.split(Component.literal(buyHints.get(i)), 180);
                    g.renderTooltip(font, lines, mouseX, mouseY);
                }
            }
        }
    }

    private void renderMarkers(GuiGraphics g) {
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
                    if (idx >= 0 && idx < BUILDING_COLORS.length) {
                        box(g, x, y, 2, m.squad == 1 ? 0xFF802020 : BUILDING_COLORS[idx]);
                        if (m.squad == 1) g.drawString(font, "x", x - 2, y - 4, 0xFFFFFFFF);
                    }
                }
            }
        }
        for (int s = 1; s <= KingdomData.SQUADS; s++) {
            if (cn[s] > 0) {
                int x = sx(cx[s] / (double) cn[s]), y = sy(cz[s] / (double) cn[s]);
                g.drawString(font, String.valueOf(s), x + 4, y - 10, s == squad ? 0xFFFFFF40 : 0xFFB0FFB0);
            }
        }
        if (selectedBuilding >= 0 && selectedBuilding < view.buildingList.size()) {
            KingdomView.BuildingView b = view.buildingList.get(selectedBuilding);
            int x = sx(b.x), y = sy(b.z);
            g.fill(x - 7, y - 7, x + 8, y - 6, 0xFFFFFFFF);
            g.fill(x - 7, y + 7, x + 8, y + 8, 0xFFFFFFFF);
            g.fill(x - 7, y - 7, x - 6, y + 8, 0xFFFFFFFF);
            g.fill(x + 7, y - 7, x + 8, y + 8, 0xFFFFFFFF);
        }
    }

    private void renderPanel(GuiGraphics g) {
        int px = panelX();
        g.fill(px, 0, width, height, 0xF0181A20);
        g.fill(px, 0, px + 1, height, 0xFF3A3D48);
        int x = px + 8;
        switch (tab) {
            case ARMY -> renderArmy(g, x);
            case BUILD -> renderBuild(g, x);
            case LOG -> renderLog(g, x);
        }
        if (height >= 300) g.drawString(font, "ПКМ - двигать, колесо - масштаб", x, height - bh - 20, 0xFF707070);
    }

    private void pair(GuiGraphics g, int x, int y, String l1, String v1, int c1, String l2, String v2, int c2) {
        g.drawString(font, l1, x, y, 0xFFB0B0B0);
        g.drawString(font, v1, x + 62, y, c1);
        g.drawString(font, l2, x + 100, y, 0xFFB0B0B0);
        g.drawString(font, v2, x + 160, y, c2);
    }

    private void renderArmy(GuiGraphics g, int x) {
        layout();
        g.drawString(font, "День " + view.day + "  |  налётов " + view.raids + ", освобождено " + view.freed, x, 28, 0xFFFFD84A);
        pair(g, x, 40, "Население", view.pop + "/" + view.cap, view.pop >= view.cap ? 0xFFFF9090 : 0xFFFFFFFF,
                "Еда", String.valueOf(view.food), view.food < 20 ? 0xFFFF6060 : 0xFFFFFFFF);
        pair(g, x, 51, "Железо", String.valueOf(view.iron), 0xFFFFFFFF, "Патроны", String.valueOf(view.ammo), 0xFFFFFFFF);
        pair(g, x, 62, "Солдаты", view.soldiers + "/" + view.soldierCap, 0xFFFFFFFF, "Танки", view.tanks + "/" + view.tankCap, 0xFFFFFFFF);
        g.drawString(font, "Отряд (клавиши 1-5):", x, lySquadLbl, 0xFFB0B0B0);
        g.drawString(font, "Приказ по клику на карту:", x, lyOrderLbl, 0xFFB0B0B0);
        g.drawString(font, "Отряд " + squad + ": солдат " + view.squadSoldiers[squad] + ", танков " + view.squadTanks[squad], x, lyInfo, 0xFFFFFFFF);
        int ord = view.squadOrder[squad];
        g.drawString(font, "Приказ: " + (ord == 0 ? "нет" : ORDER_NAMES[ord]), x, lyInfo + 11, 0xFFE0E0A0);
    }

    private void renderBuild(GuiGraphics g, int x) {
        layout();
        BuildingType[] types = BuildingType.values();
        g.drawString(font, "Твои здания (клик - на карту):", x, lyList - 11, 0xFFB0B0B0);
        int y = lyList;
        int bottom = height - bh - 6 - 34;
        int rows = Math.max(1, (bottom - y) / 11);
        listScroll = Math.max(0, Math.min(listScroll, Math.max(0, view.buildingList.size() - rows)));
        for (int i = listScroll; i < view.buildingList.size() && i < listScroll + rows; i++) {
            KingdomView.BuildingView b = view.buildingList.get(i);
            String cap = b.valid && b.capacity > 0 ? "  +" + b.capacity + " мест" : "";
            String line = (b.valid ? "+ " : "x ") + types[b.type].title + cap;
            int color = b.valid ? 0xFF80FF80 : 0xFFFF8080;
            if (i == selectedBuilding) g.fill(x - 2, y - 1, x + 190, y + 10, 0x60FFFFFF);
            g.drawString(font, line, x, y, color);
            y += 11;
        }
        if (view.buildingList.isEmpty()) g.drawString(font, "Пока нет. Построй комнату, поставь знак.", x, y, 0xFF808080);
        if (selectedBuilding >= 0 && selectedBuilding < view.buildingList.size()) {
            KingdomView.BuildingView b = view.buildingList.get(selectedBuilding);
            int dy = height - bh - 6 - 32;
            g.fill(x - 4, dy - 2, panelX() + PANEL - 4, height - bh - 9, 0x80000000);
            int i = 0;
            for (FormattedCharSequence l : font.split(Component.literal(b.text), 190)) {
                if (i++ >= 3) break;
                g.drawString(font, l, x, dy + (i - 1) * 10, b.valid ? 0xFFB8FFB8 : 0xFFFFB8B8);
            }
        }
    }

    private void renderLog(GuiGraphics g, int x) {
        int y = 34;
        g.drawString(font, "Журнал событий", x, y, 0xFFFFD84A);
        y += 14;
        int maxY = height - 48;
        for (int i = view.log.size() - 1 - listScroll; i >= 0 && y < maxY; i--) {
            for (FormattedCharSequence l : font.split(Component.literal(view.log.get(i)), 190)) {
                if (y >= maxY) break;
                g.drawString(font, l, x, y, 0xFFE0E0E0);
                y += 10;
            }
            y += 3;
        }
        if (view.log.isEmpty()) g.drawString(font, "Пока тихо.", x, y, 0xFF808080);
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
        if (button == 0 && tab == Tab.BUILD && mx >= panelX()) {
            int y0 = lyList;
            int idx = listScroll + (int) ((my - y0) / 11);
            if (my >= y0 && idx >= 0 && idx < view.buildingList.size()) {
                selectedBuilding = idx;
                KingdomView.BuildingView b = view.buildingList.get(idx);
                centerX = b.x;
                centerZ = b.z;
                dirty = true;
                return true;
            }
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
        if (mx >= panelX()) {
            listScroll = Math.max(0, listScroll + (delta > 0 ? -1 : 1));
            return true;
        }
        int old = scaleIdx;
        scaleIdx = Math.max(0, Math.min(SCALES.length - 1, scaleIdx + (delta > 0 ? -1 : 1)));
        if (old != scaleIdx) dirty = true;
        return true;
    }

    @Override
    public boolean keyPressed(int key, int scan, int mods) {
        if (key >= 49 && key <= 53 && tab == Tab.ARMY) {
            squad = key - 48;
            rebuildWidgets();
            return true;
        }
        if (key == ClientSetup.MAP.getKey().getValue()) {
            onClose();
            return true;
        }
        return super.keyPressed(key, scan, mods);
    }
}
