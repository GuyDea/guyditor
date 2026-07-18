const noFloatTime = {
  meta: {
    type: "problem",
    docs: {
      description: "forbid floating-point arithmetic on time-model values",
    },
    schema: [],
  },
  create() {
    // TODO: Enforce rational time-model arithmetic once those typed values exist.
    return {};
  },
};

export default {
  rules: {
    "no-float-time": noFloatTime,
  },
};
