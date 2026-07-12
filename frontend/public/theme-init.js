try {
  const theme = localStorage.getItem("mf:theme") === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="color-scheme"]').content = theme;
  document.querySelector('meta[name="theme-color"]').content = theme === "dark" ? "#080d13" : "#f2f4f7";
} catch {
  // Storage can be unavailable in privacy-restricted contexts; CSS defaults to dark.
}
