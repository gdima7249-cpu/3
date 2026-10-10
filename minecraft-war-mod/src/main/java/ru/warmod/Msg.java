package ru.warmod;

import org.bukkit.ChatColor;

public final class Msg {
    public static final String PREFIX = "&6[Война] &f";

    private Msg() {
    }

    public static String c(String s) {
        return ChatColor.translateAlternateColorCodes('&', s);
    }

    /** Цвет чата для цвета баннера. */
    public static String code(String color) {
        return switch (color) {
            case "RED" -> "&c";
            case "ORANGE" -> "&6";
            case "YELLOW" -> "&e";
            case "LIME" -> "&a";
            case "GREEN" -> "&2";
            case "CYAN" -> "&3";
            case "LIGHT_BLUE" -> "&b";
            case "BLUE" -> "&9";
            case "PURPLE", "MAGENTA" -> "&5";
            case "PINK" -> "&d";
            case "GRAY" -> "&8";
            case "LIGHT_GRAY" -> "&7";
            case "BLACK" -> "&0";
            case "BROWN" -> "&4";
            default -> "&f";
        };
    }

    public static final java.util.List<String> COLORS = java.util.List.of(
            "WHITE", "ORANGE", "MAGENTA", "LIGHT_BLUE", "YELLOW", "LIME", "PINK", "GRAY",
            "LIGHT_GRAY", "CYAN", "PURPLE", "BLUE", "BROWN", "GREEN", "RED", "BLACK");
}
