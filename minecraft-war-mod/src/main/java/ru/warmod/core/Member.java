package ru.warmod.core;

import java.util.UUID;

public final class Member {
    public UUID id;
    public String name;
    public Rank rank = Rank.PRIVATE;
    /** Заслуги: растут за убийства, задания, захваты. От них зависит повышение. */
    public int merit;
    public long joinedAt;
    public int kills;
    public int deaths;

    public Member() {
    }

    public Member(UUID id, String name, Rank rank, long joinedAt) {
        this.id = id;
        this.name = name;
        this.rank = rank;
        this.joinedAt = joinedAt;
    }
}
