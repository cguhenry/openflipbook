(function () {
  try {
    var d = document.documentElement;
    var t = localStorage.getItem("openflipbook.theme");
    if (t === "sepia" || t === "dark" || t === "light") {
      d.setAttribute("data-theme", t);
    } else {
      d.setAttribute("data-theme", "light");
    }
    var raw =
      localStorage.getItem("openflipbook.uiLocale") ||
      d.getAttribute("lang") ||
      "en";
    var clean = (raw === "auto" ? navigator.language || "en" : raw).replace(
      /_/g,
      "-",
    );
    var parts = clean.split("-").filter(Boolean);
    var primary = (parts[0] || "en").toLowerCase();
    var rest = parts.slice(1).map(function (part) {
      return part.toLowerCase();
    });
    var traditional =
      primary === "zh" &&
      (rest.indexOf("hant") >= 0 ||
        rest.some(function (part) {
          return part === "tw" || part === "hk" || part === "mo";
        }));
    var head = traditional ? "zh-TW" : primary;
    d.setAttribute("lang", head);
    var rtl = head === "ar" || head === "he" || head === "fa" || head === "ur";
    d.setAttribute("dir", rtl ? "rtl" : "ltr");
  } catch (_) {}
})();
