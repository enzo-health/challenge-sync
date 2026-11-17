// "My avatar": design the little character that stands for you at the weekly lottery
// (app/admin/lottery). A live 3D preview beside grouped swatches and option chips; Save stores it
// (PUT /api/me/avatar), or, when it is exactly your generated look, clears the saved one
// (DELETE) so you go back to following the generated default. Signed-out visitors are sent to
// sign in by app/middleware.rs, like every other page.
import { Suspense, lazy, useMemo, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getGetMyAvatarQueryKey, useGetMe, useGetMyAvatar } from "@linkedin-challenge/client/react-query";
import { getResetMyAvatarUrl, getSaveMyAvatarUrl, type ApiError, type MyAvatar } from "@linkedin-challenge/client";
import {
  AVATAR_OPTIONS, parseAvatar, randomAvatar, sameAvatar,
  type AvatarField, type AvatarSpec,
} from "../../../components/lottery/avatar-model";
import { defaultAvatar, resolveLook } from "../../../components/lottery/look";
import { errorText } from "../../../components/host-block";

const AvatarPreview = lazy(() => import("../../../components/lottery/avatar-preview"));

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(REDUCED_MOTION);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => window.matchMedia(REDUCED_MOTION).matches,
    () => false,
  );
}

// --- labels --------------------------------------------------------------------------------------

const LABELS: Record<string, string> = {
  // eyes
  dot: "Dots", big: "Big", sleepy: "Sleepy", happy: "Happy", wink: "Wink", starry: "Starry",
  // brows / nose / ears / hat / hair
  none: "None", soft: "Soft", arched: "Arched", angry: "Angry", worried: "Worried", thick: "Thick",
  button: "Button", pointy: "Pointy", round: "Round", snout: "Snout",
  beanie: "Beanie", party: "Party hat", antenna: "Antenna", cap: "Cap", bow: "Bow", sprout: "Sprout",
  buzz: "Buzz", bob: "Bob", spiky: "Spiky", mohawk: "Mohawk", bun: "Bun", pigtails: "Pigtails",
  curly: "Curly", swoop: "Swoop", long: "Long",
  crew: "Crew cut", sidepart: "Side part", textured: "Textured", receding: "Receding", classicbob: "Classic bob",
  shoulder: "Shoulder length", longdown: "Long, worn down", ponytail: "Ponytail",
  // facial hair
  stubble: "Stubble", moustache: "Moustache", goatee: "Goatee", shortbeard: "Short beard", fullbeard: "Full beard",
  // mouth
  smile: "Smile", grin: "Grin", smirk: "Smirk", o: "Ooh", flat: "Flat", tooth: "Toothy",
  // build
  signature: "Signature", small: "Small", tall: "Tall", lanky: "Lanky", bobble: "Bobblehead",
};
/** Where a value means something else in one field ("none" hair is bald). */
const FIELD_LABELS: Partial<Record<AvatarField, Record<string, string>>> = { hair: { none: "Bald" }, facialHair: { none: "Clean-shaven" } };
const label = (value: string, field?: AvatarField) => (field && FIELD_LABELS[field]?.[value]) ?? LABELS[value] ?? value;

/** The hair list is long: the everyday cuts first, then (from "bob" on) the playful ones. */
const FUN_HAIR_FROM = "bob";

const COLOR_NAMES: Record<string, string> = {
  "#ffe8d6": "peach", "#fff3b0": "lemon", "#ffd6e0": "blush", "#d8f3dc": "mint", "#e0e7ff": "periwinkle",
  "#ffe5b4": "apricot", "#f1e4ff": "lilac", "#cdf5fd": "ice", "#f5cfa9": "sand", "#e0ac7e": "caramel",
  "#b97a50": "cinnamon", "#8a5a3c": "cocoa", "#5b3a29": "espresso",
  "#ff4d6d": "watermelon", "#ffb703": "sunflower", "#3a86ff": "sky blue", "#2ec4b6": "lagoon", "#8338ec": "grape",
  "#fb5607": "tangerine", "#06d6a0": "mint green", "#ff70a6": "bubblegum", "#4cc9f0": "cyan", "#f72585": "magenta",
  "#ffffff": "white", "#2b2d42": "ink", "#ffd166": "butter", "#ef476f": "raspberry", "#118ab2": "ocean", "#ff9f1c": "orange",
  "#2b1d3a": "black", "#4a2f1d": "dark brown", "#8b5a2b": "brown", "#d9a441": "blond", "#e4572e": "ginger",
  "#9aa0a6": "grey", "#f5f5f5": "silver white",
};
const colorName = (hex: string) => COLOR_NAMES[hex.toLowerCase()] ?? hex;

const GROUPS: { title: string; blurb: string; fields: { field: AvatarField; name: string }[] }[] = [
  {
    title: "Face",
    blurb: "The important bit.",
    fields: [
      { field: "skin", name: "Skin" },
      { field: "eyes", name: "Eyes" },
      { field: "brows", name: "Eyebrows" },
      { field: "nose", name: "Nose" },
      { field: "mouth", name: "Mouth" },
      { field: "ears", name: "Ears" },
    ],
  },
  {
    title: "Hair",
    blurb: "The crowd sees it from behind, so make it count.",
    fields: [
      { field: "hair", name: "Style" },
      { field: "facialHair", name: "Facial hair" },
      { field: "hairColor", name: "Colour (hair, brows and beard)" },
    ],
  },
  {
    title: "Body",
    blurb: "Signature is the shape you were born with here.",
    fields: [
      { field: "build", name: "Build" },
      { field: "outfit", name: "Outfit colour" },
    ],
  },
  {
    title: "Extras",
    blurb: "Hat and shoes.",
    fields: [
      { field: "hat", name: "Hat" },
      { field: "accent", name: "Accent colour (hat and shoes)" },
    ],
  },
];

const COLOR_FIELDS = new Set<AvatarField>(["skin", "hairColor", "outfit", "accent"]);

// --- saving ----------------------------------------------------------------------------------------

/**
 * PUT (or DELETE) /api/me/avatar, saying exactly what went wrong. The generated fetch functions
 * parse every body as JSON, which loses the status of the root middleware's text/plain 401; the
 * URLs and the response types still come from the generated client.
 */
async function send(avatar: AvatarSpec | null): Promise<{ ok: true; saved: MyAvatar } | { ok: false; message: string }> {
  let res: Response;
  try {
    res = avatar
      ? await fetch(getSaveMyAvatarUrl(), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(avatar) })
      : await fetch(getResetMyAvatarUrl(), { method: "DELETE" });
  } catch (error) {
    // A host block or no answer at all (components/host-block.tsx names both).
    return { ok: false, message: errorText(error, `The request didn’t complete: ${error instanceof Error ? error.message : String(error)}`) };
  }
  const text = await res.text();
  const json = (() => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  })();
  if (res.ok && json && typeof json === "object" && "avatar" in json) return { ok: true, saved: json as MyAvatar };
  if (json && typeof json === "object" && typeof (json as ApiError).error === "string") return { ok: false, message: (json as ApiError).error };
  if (res.status === 401) return { ok: false, message: `You’re signed out (the server said “${text.trim() || "401"}”). Sign in again, then save.` };
  return { ok: false, message: `The server answered ${res.status}${text ? `: ${text.slice(0, 200)}` : " with no body"}.` };
}

// --- controls --------------------------------------------------------------------------------------

function Field({ field, name, value, onPick }: { field: AvatarField; name: string; value: string; onPick: (v: string) => void }) {
  const id = `avatar-${field}`;
  const options = AVATAR_OPTIONS[field] as readonly string[];
  const color = COLOR_FIELDS.has(field);
  const chip = (option: string) => (
    <button key={option} type="button" className="avatar-chip" aria-pressed={value === option} data-value={option} onClick={() => onPick(option)}>
      {label(option, field)}
    </button>
  );
  const split = field === "hair" ? options.indexOf(FUN_HAIR_FROM) : -1;
  return (
    <div className="avatar-field">
      <div className="avatar-field-name" id={id}>
        {name}
        <span className="avatar-field-value">{color ? colorName(value) : label(value, field)}</span>
      </div>
      <div className={color ? "avatar-swatches" : "avatar-chips"} role="group" aria-labelledby={id}>
        {color
          ? options.map((option) => (
              <button
                key={option}
                type="button"
                className="avatar-swatch"
                style={{ background: option }}
                aria-pressed={value === option}
                aria-label={`${name}: ${colorName(option)}`}
                title={colorName(option)}
                data-value={option}
                onClick={() => onPick(option)}
              />
            ))
          : split > 0
            ? (
                <>
                  <span className="avatar-subhead">Everyday</span>
                  {options.slice(0, split).map(chip)}
                  <span className="avatar-subhead">Just for fun</span>
                  {options.slice(split).map(chip)}
                </>
              )
            : options.map(chip)}
      </div>
    </div>
  );
}

type Status = { kind: "idle" } | { kind: "saving" } | { kind: "saved"; text: string } | { kind: "error"; text: string };

function Editor({ memberId, displayName, saved }: { memberId: number; displayName: string; saved: MyAvatar }) {
  const queryClient = useQueryClient();
  const reducedMotion = useReducedMotion();
  const fallback = useMemo(() => defaultAvatar(memberId), [memberId]);
  // What the server has: their avatar, or (none saved) their generated look.
  const initial = useMemo(() => {
    if (!saved.avatar) return { avatar: fallback, problem: null };
    const parsed = parseAvatar(saved.avatar);
    return "avatar" in parsed ? { avatar: parsed.avatar, problem: null } : { avatar: fallback, problem: parsed.error };
  }, [saved, fallback]);
  // `custom`: the server holds an avatar (not the generated look); `unreadable`: it holds one this
  // page can't show, which only a save can replace.
  const [baseline, setBaseline] = useState({
    avatar: initial.avatar,
    custom: saved.avatar != null && initial.problem == null,
    unreadable: initial.problem != null,
  });
  const [form, setForm] = useState<AvatarSpec>(initial.avatar);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const look = useMemo(() => resolveLook(memberId, form), [memberId, form]);

  const isDefault = sameAvatar(form, fallback);
  const dirty = !sameAvatar(form, baseline.avatar) || baseline.unreadable;

  const update = (next: AvatarSpec) => {
    setForm(next);
    if (status.kind !== "saving") setStatus({ kind: "idle" });
  };
  const pick = (field: AvatarField, value: string) => update({ ...form, [field]: value } as AvatarSpec);

  const save = async () => {
    setStatus({ kind: "saving" });
    const toDefault = isDefault;
    const result = await send(toDefault ? null : form);
    if (!result.ok) {
      setStatus({ kind: "error", text: result.message });
      return;
    }
    setBaseline({ avatar: form, custom: !toDefault, unreadable: false });
    await queryClient.invalidateQueries({ queryKey: getGetMyAvatarQueryKey() });
    setStatus({
      kind: "saved",
      text: toDefault
        ? "Saved! You’re back to your generated look."
        : "Saved! This is you at the next lottery.",
    });
  };

  const stateLine =
    status.kind === "saving"
      ? "Saving…"
      : status.kind === "saved"
        ? status.text
        : dirty
          ? "Unsaved changes"
          : baseline.custom
            ? "Saved"
            : "Your generated look (nothing saved yet)";

  return (
    <div className="avatar-editor">
      <section className="avatar-stage" aria-label="Preview">
        <Suspense fallback={<div className="avatar-preview loading">Warming up the stage…</div>}>
          <AvatarPreview look={look} name={displayName} reducedMotion={reducedMotion} />
        </Suspense>
      </section>

      <section className="avatar-controls" aria-label="Customize">
        {initial.problem && baseline.unreadable && (
          <div className="notice err">
            Your saved avatar can&rsquo;t be shown here ({initial.problem}), so this starts from your generated look.
            Saving replaces it.
          </div>
        )}
        <div className="avatar-actions">
          <button type="button" className="btn avatar-fun" onClick={() => update(randomAvatar())}>
            Randomize
          </button>
          <button type="button" className="btn avatar-fun ghosty" onClick={() => update(fallback)} disabled={isDefault}>
            Reset to default
          </button>
          <button
            type="button"
            className="btn avatar-save"
            onClick={() => void save()}
            disabled={!dirty || status.kind === "saving"}
          >
            {status.kind === "saving" ? "Saving…" : "Save"}
          </button>
        </div>
        <div
          className={`avatar-status ${status.kind === "error" ? "err" : status.kind === "saved" ? "ok" : dirty ? "dirty" : ""}`}
          role="status"
          aria-live="polite"
          data-state={status.kind === "error" ? "error" : status.kind === "saving" ? "saving" : dirty ? "unsaved" : "saved"}
        >
          {status.kind === "error" ? (
            <>
              <strong>Not saved:</strong> {status.text}
            </>
          ) : (
            stateLine
          )}
        </div>

        {GROUPS.map((group) => (
          <fieldset key={group.title} className="avatar-group">
            <legend>{group.title}</legend>
            <p className="avatar-blurb">{group.blurb}</p>
            {group.fields.map(({ field, name }) => (
              <Field key={field} field={field} name={name} value={form[field]} onPick={(v) => pick(field, v)} />
            ))}
          </fieldset>
        ))}
      </section>
    </div>
  );
}

export default function MyAvatarPage() {
  const me = useGetMe();
  const avatar = useGetMyAvatar();
  const who = me.data?.status === 200 ? me.data.data : undefined;

  const head = (
    <div className="avatar-head">
      <h1 className="lottery-title">Your avatar</h1>
      <p className="muted">
        This little character stands in for you at the weekly lottery: on stage when you posted that week, in the
        crowd when you didn&rsquo;t. <a href="/me">Back to my posts</a>
      </p>
    </div>
  );

  if (me.isLoading || avatar.isLoading) {
    return (
      <div className="avatar-page">
        {head}
        <div className="spinner">Loading…</div>
      </div>
    );
  }
  if (!who?.signedIn || who.memberId == null || avatar.data?.status === 401) {
    return (
      <div className="empty">
        Your session expired. <a href="/auth/login">Log in again</a>.
      </div>
    );
  }
  if (avatar.error || avatar.data?.status !== 200) {
    const reason = avatar.error
      ? errorText(avatar.error, `Loading your avatar failed: ${avatar.error instanceof Error ? avatar.error.message : String(avatar.error)}`)
      : `Loading your avatar failed: the server answered ${avatar.data?.status}${avatar.data && "error" in avatar.data.data ? ` (${avatar.data.data.error})` : ""}.`;
    return (
      <div className="avatar-page">
        {head}
        <div className="notice err">{reason}</div>
      </div>
    );
  }
  return (
    <div className="avatar-page">
      {head}
      <Editor memberId={who.memberId} displayName={who.displayName ?? "You"} saved={avatar.data.data} />
    </div>
  );
}
