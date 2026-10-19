using System.Collections.Generic;
using UnityEngine;

// Точка входа: создаёт игру автоматически при запуске любой сцены.
public static class Bootstrap
{
    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
    static void Init()
    {
        new GameObject("BearGame").AddComponent<GameManager>();
    }
}

public class Enemy
{
    public Transform t;
    public Vector3 basePos;
    public float range, phase;
    public bool alongX;
    public bool alive = true;
}

public class GameManager : MonoBehaviour
{
    // ---- Состояние ----
    Transform world, player, bearVisual, legL, legR, goal;
    CharacterController cc;
    Camera cam;
    readonly List<Transform> coins = new List<Transform>();
    readonly List<Enemy> enemies = new List<Enemy>();
    Vector3 spawn = new Vector3(0, 0.1f, 8);
    Vector3 goalPos = new Vector3(3, 17.5f, 12);
    float vy, yaw = 180f, pitch = 25f, invul, attack;
    int hp = 3, score, totalCoins, jumps;
    bool won;
    Vector3 horizVel;

    // ---- Ввод ----
    Vector2 move;
    bool jumpPressed, attackPressed;
    int stickId = -1, camId = -1;
    Vector2 stickOrigin, stickPos;

    Rect JumpRect => new Rect(Screen.width - Screen.height * 0.28f, Screen.height * 0.62f, Screen.height * 0.22f, Screen.height * 0.22f);
    Rect AttackRect => new Rect(Screen.width - Screen.height * 0.52f, Screen.height * 0.72f, Screen.height * 0.18f, Screen.height * 0.18f);

    void Start()
    {
        Application.targetFrameRate = 60;
        Build();
    }

    // ------------------------------------------------------------------ Мир
    static Material Mat(Color c)
    {
        Shader s = Shader.Find("Standard");
        if (s == null) s = Shader.Find("Universal Render Pipeline/Lit");
        if (s == null) s = Shader.Find("Sprites/Default");
        var m = new Material(s);
        m.color = c;
        return m;
    }

    GameObject Prim(PrimitiveType type, Vector3 pos, Vector3 scale, Color c, Transform parent, bool keepCollider)
    {
        var g = GameObject.CreatePrimitive(type);
        g.transform.SetParent(parent, false);
        g.transform.position = pos;
        g.transform.localScale = scale;
        g.GetComponent<Renderer>().material = Mat(c);
        if (!keepCollider) Destroy(g.GetComponent<Collider>());
        return g;
    }

    void Box(float x, float topY, float z, float w, float h, float d, Color c)
    {
        Prim(PrimitiveType.Cube, new Vector3(x, topY - h / 2f, z), new Vector3(w, h, d), c, world, true);
    }

    void Build()
    {
        if (world != null) Destroy(world.gameObject);
        world = new GameObject("World").transform;
        coins.Clear(); enemies.Clear();
        hp = 3; score = 0; won = false; vy = 0; horizVel = Vector3.zero; invul = 0; attack = 0;

        // Освещение и небо
        var lightGo = new GameObject("Sun");
        lightGo.transform.SetParent(world, false);
        lightGo.transform.rotation = Quaternion.Euler(50, -30, 0);
        var l = lightGo.AddComponent<Light>();
        l.type = LightType.Directional; l.intensity = 1.1f; l.shadows = LightShadows.Soft;
        RenderSettings.ambientLight = new Color(0.6f, 0.65f, 0.7f);

        if (cam == null)
        {
            cam = Camera.main;
            if (cam == null) { var cg = new GameObject("Cam"); cam = cg.AddComponent<Camera>(); cg.tag = "MainCamera"; }
            cam.clearFlags = CameraClearFlags.SolidColor;
            cam.backgroundColor = new Color(0.56f, 0.83f, 1f);
        }

        // Остров и платформы
        Box(0, 0, 0, 50, 3, 50, new Color(0.43f, 0.75f, 0.29f));
        float[][] pl = {
            new[]{10f,1.5f,6f,5f,1f,5f}, new[]{16f,3f,2f,4f,1f,4f}, new[]{20f,4.5f,-5f,4f,1f,4f},
            new[]{15f,6f,-11f,4f,1f,4f}, new[]{8f,7.5f,-14f,4f,1f,4f}, new[]{1f,9f,-12f,3.5f,1f,3.5f},
            new[]{-6f,10.5f,-8f,3.5f,1f,3.5f}, new[]{-12f,12f,-2f,4f,1f,4f}, new[]{-10f,13.5f,6f,4f,1f,4f},
            new[]{-4f,15f,10f,3.5f,1f,3.5f}, new[]{3f,16.5f,12f,6f,1f,6f}
        };
        foreach (var p in pl)
        {
            Box(p[0], p[1], p[2], p[3], p[4], p[5], new Color(0.79f, 0.54f, 0.29f));
            AddCoin(p[0], p[1] + 1.2f, p[2]);
        }
        for (int i = 0; i < 12; i++)
        {
            float a = i / 12f * Mathf.PI * 2f;
            AddCoin(Mathf.Cos(a) * 12f, 1.2f, Mathf.Sin(a) * 12f);
        }
        totalCoins = coins.Count;

        // Вода
        Prim(PrimitiveType.Cube, new Vector3(0, -6, 0), new Vector3(400, 0.1f, 400), new Color(0.16f, 0.5f, 0.84f), world, false);

        // Деревья
        float[][] trees = { new[]{-18f,-18f}, new[]{-20f,5f}, new[]{-8f,18f}, new[]{18f,18f}, new[]{22f,-14f}, new[]{-22f,-8f}, new[]{6f,-20f}, new[]{-14f,20f} };
        foreach (var t in trees)
        {
            Prim(PrimitiveType.Cylinder, new Vector3(t[0], 1.5f, t[1]), new Vector3(0.7f, 1.5f, 0.7f), new Color(0.48f, 0.29f, 0.15f), world, false);
            Prim(PrimitiveType.Sphere, new Vector3(t[0], 4.2f, t[1]), new Vector3(3.4f, 3.4f, 3.4f), new Color(0.18f, 0.56f, 0.23f), world, false);
        }

        // Цель — горшок с мёдом
        var gg = new GameObject("Goal");
        gg.transform.SetParent(world, false);
        gg.transform.position = goalPos;
        goal = gg.transform;
        var pot = Prim(PrimitiveType.Sphere, goalPos, new Vector3(1.6f, 1.4f, 1.6f), new Color(0.71f, 0.4f, 0.11f), goal, false);
        Prim(PrimitiveType.Cylinder, goalPos + Vector3.up * 0.6f, new Vector3(1.1f, 0.05f, 1.1f), new Color(1f, 0.77f, 0f), goal, false);

        // Враги
        AddEnemy(-8, 0, -8, 6, true); AddEnemy(10, 0, 14, 6, false); AddEnemy(-14, 0, 10, 5, true);
        AddEnemy(16, 3, 2, 1.4f, false); AddEnemy(-12, 12, -2, 1.4f, true); AddEnemy(8, 7.5f, -14, 1.4f, false);

        BuildPlayer();
    }

    void AddCoin(float x, float y, float z)
    {
        var c = Prim(PrimitiveType.Cylinder, new Vector3(x, y, z), new Vector3(0.8f, 0.06f, 0.8f), new Color(1f, 0.82f, 0.17f), world, false);
        c.transform.rotation = Quaternion.Euler(90, 0, 0);
        coins.Add(c.transform);
    }

    void AddEnemy(float x, float y, float z, float range, bool alongX)
    {
        var e = Prim(PrimitiveType.Sphere, new Vector3(x, y + 0.5f, z), new Vector3(1.2f, 1f, 1.2f), new Color(0.85f, 0.31f, 0.31f), world, false);
        Prim(PrimitiveType.Sphere, e.transform.position + new Vector3(-0.2f, 0.2f, 0.45f), Vector3.one * 0.25f, Color.white, e.transform, false);
        Prim(PrimitiveType.Sphere, e.transform.position + new Vector3(0.2f, 0.2f, 0.45f), Vector3.one * 0.25f, Color.white, e.transform, false);
        enemies.Add(new Enemy { t = e.transform, basePos = new Vector3(x, y, z), range = range, alongX = alongX, phase = Random.value * 6f });
    }

    void BuildPlayer()
    {
        var pg = new GameObject("Player");
        pg.transform.SetParent(world, false);
        pg.transform.position = spawn;
        player = pg.transform;
        cc = pg.AddComponent<CharacterController>();
        cc.height = 1.4f; cc.radius = 0.4f; cc.center = new Vector3(0, 0.7f, 0); cc.stepOffset = 0.3f;

        var vis = new GameObject("Visual");
        vis.transform.SetParent(player, false);
        bearVisual = vis.transform;
        var brown = new Color(0.54f, 0.35f, 0.17f);
        var tan = new Color(0.85f, 0.71f, 0.54f);
        Prim(PrimitiveType.Sphere, player.position + new Vector3(0, 0.55f, 0), new Vector3(1f, 1.05f, 0.9f), brown, bearVisual, false);
        Prim(PrimitiveType.Sphere, player.position + new Vector3(0, 1.2f, 0), Vector3.one * 0.85f, brown, bearVisual, false);
        Prim(PrimitiveType.Sphere, player.position + new Vector3(0, 1.12f, 0.36f), Vector3.one * 0.4f, tan, bearVisual, false);
        Prim(PrimitiveType.Sphere, player.position + new Vector3(0, 1.18f, 0.55f), Vector3.one * 0.14f, Color.black, bearVisual, false);
        Prim(PrimitiveType.Sphere, player.position + new Vector3(-0.3f, 1.55f, 0), Vector3.one * 0.3f, brown, bearVisual, false);
        Prim(PrimitiveType.Sphere, player.position + new Vector3(0.3f, 1.55f, 0), Vector3.one * 0.3f, brown, bearVisual, false);
        Prim(PrimitiveType.Sphere, player.position + new Vector3(-0.15f, 1.3f, 0.36f), Vector3.one * 0.12f, Color.black, bearVisual, false);
        Prim(PrimitiveType.Sphere, player.position + new Vector3(0.15f, 1.3f, 0.36f), Vector3.one * 0.12f, Color.black, bearVisual, false);
        legL = Prim(PrimitiveType.Sphere, player.position + new Vector3(-0.25f, 0.15f, 0.05f), Vector3.one * 0.34f, brown, bearVisual, false).transform;
        legR = Prim(PrimitiveType.Sphere, player.position + new Vector3(0.25f, 0.15f, 0.05f), Vector3.one * 0.34f, brown, bearVisual, false).transform;
    }

    // ------------------------------------------------------------------ Ввод
    void ReadInput()
    {
        move = Vector2.zero; jumpPressed = false; attackPressed = false;
        Vector2 camDelta = Vector2.zero;

        // Клавиатура/мышь (для проверки в редакторе)
        move = new Vector2(Input.GetAxisRaw("Horizontal"), Input.GetAxisRaw("Vertical"));
        if (Input.GetKeyDown(KeyCode.Space)) jumpPressed = true;
        if (Input.GetKeyDown(KeyCode.E)) attackPressed = true;
        if (Input.GetMouseButton(1)) camDelta += new Vector2(Input.GetAxis("Mouse X"), -Input.GetAxis("Mouse Y")) * 8f;

        // Сенсорный экран
        foreach (Touch t in Input.touches)
        {
            Vector2 pos = new Vector2(t.position.x, Screen.height - t.position.y); // координаты как в OnGUI
            if (t.phase == TouchPhase.Began)
            {
                if (JumpRect.Contains(pos)) jumpPressed = true;
                else if (AttackRect.Contains(pos)) attackPressed = true;
                else if (pos.x < Screen.width * 0.45f && stickId < 0) { stickId = t.fingerId; stickOrigin = pos; stickPos = pos; }
                else if (camId < 0) camId = t.fingerId;
            }
            if (t.fingerId == stickId)
            {
                stickPos = pos;
                Vector2 d = (stickPos - stickOrigin) / (Screen.height * 0.1f);
                if (d.magnitude > 1f) d.Normalize();
                move = new Vector2(d.x, -d.y);
            }
            else if (t.fingerId == camId)
            {
                camDelta += new Vector2(t.deltaPosition.x, -t.deltaPosition.y) * 0.25f;
            }
            if (t.phase == TouchPhase.Ended || t.phase == TouchPhase.Canceled)
            {
                if (t.fingerId == stickId) stickId = -1;
                if (t.fingerId == camId) camId = -1;
            }
        }
        if (Input.touchCount == 0) { stickId = -1; camId = -1; }

        yaw += camDelta.x;
        pitch = Mathf.Clamp(pitch + camDelta.y * -1f, 8f, 70f);
        if (Input.GetKey(KeyCode.Q)) yaw -= 90f * Time.deltaTime;
        if (Input.GetKey(KeyCode.R)) yaw += 90f * Time.deltaTime;
        if (move.magnitude > 1f) move.Normalize();
    }

    // ------------------------------------------------------------------ Обновление
    void Update()
    {
        if (world == null) return;
        ReadInput();

        if (won)
        {
            if (jumpPressed || Input.GetMouseButtonDown(0) || Input.touchCount > 0 && Input.GetTouch(0).phase == TouchPhase.Began) Build();
            return;
        }

        float dt = Time.deltaTime;
        invul -= dt; attack -= dt;

        // Движение относительно камеры
        Quaternion camRot = Quaternion.Euler(0, yaw, 0);
        Vector3 wish = camRot * new Vector3(move.x, 0, move.y);
        bool grounded = cc.isGrounded;
        float accel = grounded ? 14f : 6f;
        horizVel = Vector3.Lerp(horizVel, wish * 7f, Mathf.Min(1f, accel * dt));

        if (grounded && vy < 0) { vy = -1f; jumps = 0; }
        if (jumpPressed)
        {
            if (grounded) { vy = 10f; jumps = 1; }
            else if (jumps < 2) { vy = 9f; jumps = 2; }
        }
        if (attackPressed && attack <= 0) attack = 0.4f;
        vy -= 28f * dt;

        cc.Move((horizVel + Vector3.up * vy) * dt);
        if (wish.sqrMagnitude > 0.01f)
            bearVisual.rotation = Quaternion.Slerp(bearVisual.rotation, Quaternion.LookRotation(wish), 15f * dt);
        if (attack > 0) bearVisual.Rotate(0, 900f * dt, 0);

        // Анимация ног
        bool walking = grounded && horizVel.magnitude > 1f;
        float w = Time.time * 10f;
        float off = walking ? Mathf.Sin(w) * 0.2f : 0f;
        legL.localPosition = new Vector3(-0.25f, 0.15f, 0.05f + off);
        legR.localPosition = new Vector3(0.25f, 0.15f, 0.05f - off);
        foreach (var r in bearVisual.GetComponentsInChildren<Renderer>())
            r.enabled = invul <= 0 || Mathf.FloorToInt(Time.time * 12f) % 2 == 0;

        if (player.position.y < -8f) Respawn();

        // Монеты
        for (int i = coins.Count - 1; i >= 0; i--)
        {
            var c = coins[i];
            c.Rotate(0, 0, 180f * dt, Space.World);
            if (Vector3.Distance(c.position, player.position + Vector3.up * 0.7f) < 1.1f)
            {
                Destroy(c.gameObject); coins.RemoveAt(i); score++;
            }
        }

        // Враги
        foreach (var e in enemies)
        {
            if (!e.alive) continue;
            e.phase += dt;
            float o = Mathf.Sin(e.phase * 1.2f) * e.range;
            e.t.position = e.basePos + new Vector3(e.alongX ? o : 0, 0.5f + Mathf.Abs(Mathf.Sin(e.phase * 4f)) * 0.2f, e.alongX ? 0 : o);
            Vector3 d = e.t.position - (player.position + Vector3.up * 0.7f);
            if (new Vector2(d.x, d.z).magnitude < 1.0f && Mathf.Abs(d.y) < 1.2f)
            {
                bool stomp = vy < 0 && player.position.y > e.t.position.y;
                if (attack > 0 || stomp)
                {
                    e.alive = false; Destroy(e.t.gameObject); score += 2;
                    if (stomp && attack <= 0) vy = 9f;
                }
                else Hurt();
            }
        }

        // Цель
        goal.Rotate(0, 60f * dt, 0);
        if (Vector3.Distance(player.position + Vector3.up * 0.7f, goalPos) < 1.8f) won = true;

        UpdateCamera();
    }

    void Hurt()
    {
        if (invul > 0) return;
        hp--; invul = 1.5f; vy = 7f; horizVel = -bearVisual.forward * 6f;
        if (hp <= 0) { hp = 3; Teleport(spawn); }
    }

    void Respawn() { Teleport(spawn); Hurt(); invul = 1.5f; }

    void Teleport(Vector3 pos)
    {
        cc.enabled = false; player.position = pos; cc.enabled = true; vy = 0; horizVel = Vector3.zero;
    }

    void UpdateCamera()
    {
        Vector3 target = player.position + Vector3.up * 1.2f;
        Quaternion rot = Quaternion.Euler(pitch, yaw, 0);
        Vector3 desired = target - rot * Vector3.forward * 9f;
        cam.transform.position = Vector3.Lerp(cam.transform.position, desired, 1f - Mathf.Exp(-12f * Time.deltaTime));
        cam.transform.LookAt(target);
    }

    // ------------------------------------------------------------------ Интерфейс
    void OnGUI()
    {
        int fs = Mathf.RoundToInt(Screen.height * 0.05f);
        var style = new GUIStyle(GUI.skin.label) { fontSize = fs, fontStyle = FontStyle.Bold };
        style.normal.textColor = Color.white;
        GUI.Label(new Rect(20, 10, Screen.width / 2, fs * 2), new string('♥', hp), style);
        style.alignment = TextAnchor.UpperRight;
        GUI.Label(new Rect(Screen.width / 2, 10, Screen.width / 2 - 20, fs * 2), "Монеты: " + score + " / " + totalCoins, style);

        var btn = new GUIStyle(GUI.skin.box) { fontSize = Mathf.RoundToInt(fs * 0.5f), alignment = TextAnchor.MiddleCenter };
        btn.normal.textColor = Color.white;
        GUI.Box(JumpRect, "ПРЫЖОК", btn);
        GUI.Box(AttackRect, "УДАР", btn);
        if (stickId >= 0 || Input.touchCount == 0)
        {
            Vector2 o = stickId >= 0 ? stickOrigin : new Vector2(Screen.height * 0.2f, Screen.height * 0.78f);
            Vector2 p = stickId >= 0 ? stickPos : o;
            float r = Screen.height * 0.1f;
            GUI.Box(new Rect(o.x - r, o.y - r, r * 2, r * 2), "");
            GUI.Box(new Rect(p.x - r * 0.4f, p.y - r * 0.4f, r * 0.8f, r * 0.8f), "");
        }

        if (won)
        {
            style.alignment = TextAnchor.MiddleCenter;
            GUI.Box(new Rect(0, 0, Screen.width, Screen.height), "");
            GUI.Label(new Rect(0, 0, Screen.width, Screen.height), "Ты добрался до мёда!\nМонет: " + score + "\nНажми, чтобы сыграть ещё раз", style);
        }
    }
}
