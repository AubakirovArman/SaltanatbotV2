export const timeBlocks = [
  {
    type: "time_session",
    message0: "within UTC hours %1 to %2",
    args0: [
      { type: "field_number", name: "START", value: 13, min: 0, max: 23, precision: 1 },
      { type: "field_number", name: "END", value: 21, min: 0, max: 23, precision: 1 }
    ],
    output: "Boolean",
    colour: "#b0763b",
    tooltip: "True during a trading session window (UTC hours)."
  },
  {
    type: "time_dayofweek",
    message0: "day is %1",
    args0: [
      {
        type: "field_dropdown",
        name: "DAY",
        options: [
          ["Monday", "1"],
          ["Tuesday", "2"],
          ["Wednesday", "3"],
          ["Thursday", "4"],
          ["Friday", "5"],
          ["Saturday", "6"],
          ["Sunday", "0"]
        ]
      }
    ],
    output: "Boolean",
    colour: "#b0763b",
    tooltip: "True on the selected day of week (UTC)."
  }
];
