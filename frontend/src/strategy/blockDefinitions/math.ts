export const mathBlocks = [
  {
    type: "param_number",
    message0: "input %1 default %2 min %3 max %4 step %5 optimize %6",
    args0: [
      { type: "field_input", name: "NAME", text: "length" },
      { type: "field_number", name: "VALUE", value: 14 },
      { type: "field_number", name: "MIN", value: 1 },
      { type: "field_number", name: "MAX", value: 100 },
      { type: "field_number", name: "STEP", value: 1, min: 0.000001 },
      { type: "field_checkbox", name: "OPTIMIZE", checked: true }
    ],
    output: "Number",
    colour: "#6d72c9",
    tooltip: "A named numeric parameter with validated bounds and optional optimizer eligibility."
  },
  {
    type: "math_minmax",
    message0: "%1 of %2 and %3",
    args0: [
      {
        type: "field_dropdown",
        name: "OP",
        options: [
          ["max", "max"],
          ["min", "min"]
        ]
      },
      { type: "input_value", name: "A", check: "Number" },
      { type: "input_value", name: "B", check: "Number" }
    ],
    output: "Number",
    colour: "#6d72c9",
    tooltip: "Take the larger or smaller of two values."
  },
  {
    type: "math_single_op",
    message0: "%1 %2",
    args0: [
      {
        type: "field_dropdown",
        name: "OP",
        options: [
          ["abs", "abs"],
          ["negate", "neg"],
          ["sign", "sign"],
          ["sqrt", "sqrt"],
          ["ln", "log"],
          ["log10", "log10"],
          ["exp", "exp"]
        ]
      },
      { type: "input_value", name: "NUM", check: "Number" }
    ],
    output: "Number",
    colour: "#6d72c9",
    tooltip: "Unary math: abs, negate, sign, sqrt, natural log, log10, exp."
  },
  {
    type: "math_modulo",
    message0: "remainder of %1 ÷ %2",
    args0: [
      { type: "input_value", name: "A", check: "Number" },
      { type: "input_value", name: "B", check: "Number" }
    ],
    output: "Number",
    colour: "#6d72c9",
    tooltip: "Remainder after division (modulo)."
  },
  {
    type: "math_cond",
    message0: "if %1 then %2 else %3",
    args0: [
      { type: "input_value", name: "COND", check: "Boolean" },
      { type: "input_value", name: "A", check: "Number" },
      { type: "input_value", name: "B", check: "Number" }
    ],
    output: "Number",
    colour: "#6d72c9",
    tooltip: "Numeric ternary: pick one of two values based on a condition."
  },
  {
    type: "math_nz",
    message0: "nz %1 else %2",
    args0: [
      { type: "input_value", name: "A", check: "Number" },
      { type: "input_value", name: "B", check: "Number" }
    ],
    output: "Number",
    colour: "#6d72c9",
    tooltip: "Replace NaN/undefined (na) with a fallback value (nz)."
  }
];
