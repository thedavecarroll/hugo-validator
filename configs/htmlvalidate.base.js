// html-validate base configuration for hugo-validator
module.exports = {
  extends: ["html-validate:recommended", "html-validate:a11y"],
  rules: {
    "no-trailing-whitespace": "off",
    "void-style": "off",
    "doctype-style": "off",
    "attr-quotes": "off"
  }
};
