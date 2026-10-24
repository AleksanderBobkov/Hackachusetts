// Language helpers: native language names, text direction. No network, no guessing.

const RTL = new Set(["ar", "he", "fa", "ur", "yi", "ps", "sd", "ug", "dv"]);

/** "pl" → "polski", "en" → "English" (the language's own name; falls back to the code). */
export function languageName(code) {
  if (!code) return "";
  try {
    const name = new Intl.DisplayNames([code], { type: "language" }).of(code);
    if (name && name !== code) return name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
  } catch {
    /* unsupported code */
  }
  return code;
}

export function textDirection(code) {
  return RTL.has(String(code || "").split("-")[0].toLowerCase()) ? "rtl" : "ltr";
}

/** Apply lang + dir to an element showing text in `code`. */
export function setLanguage(el, code) {
  if (code) {
    el.lang = code;
    el.dir = textDirection(code);
  } else {
    el.removeAttribute("lang");
    el.removeAttribute("dir");
  }
}
