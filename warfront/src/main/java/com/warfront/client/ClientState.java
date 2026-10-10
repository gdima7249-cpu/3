package com.warfront.client;

import com.warfront.net.HudPacket;

import java.util.ArrayList;
import java.util.List;

/** Состояние интерфейса на клиенте. */
public final class ClientState {
    public static final class Note {
        public final String title, text;
        public final int kind;
        public final long expires;

        Note(String title, String text, int kind, long expires) {
            this.title = title;
            this.text = text;
            this.kind = kind;
            this.expires = expires;
        }
    }

    public static HudPacket hud;
    public static final List<Note> NOTES = new ArrayList<>();

    private ClientState() {
    }

    /** kind: 0 - информация, 1 - тревога, 2 - предупреждение. */
    public static void addNote(String title, String text, int kind) {
        long life = kind == 1 ? 11000 : 8000;
        NOTES.add(new Note(title, text.length() > 200 ? text.substring(0, 200) + "..." : text, kind,
                System.currentTimeMillis() + life));
        while (NOTES.size() > 4) NOTES.remove(0);
    }
}
