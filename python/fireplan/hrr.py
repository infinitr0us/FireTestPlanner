"""Heat release curves, in seconds and kW. Mirror of web/src/core/hrr.ts."""
import math

GROWTH_RATES = {"slow": 0.00293, "medium": 0.01172, "fast": 0.0469, "ultra-fast": 0.1876}


def curve_problem(curve):
    if curve is None:
        return None
    if not isinstance(curve, dict):
        return "HRR curve must be an object or null."
    if set(curve) - {"points", "source"} or ("source" in curve and not isinstance(curve["source"], str)):
        return "HRR curve accepts points and an optional text source."
    points = curve.get("points")
    if not isinstance(points, list) or not 2 <= len(points) <= 10000:
        return "HRR curve needs 2 to 10000 points."
    previous = -1
    for p in points:
        if (not isinstance(p, (list, tuple)) or len(p) != 2
                or not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and v >= 0 for v in p)
                or p[0] <= previous):
            return "HRR curve needs finite non-negative [seconds, kW] pairs with strictly increasing times."
        previous = p[0]
    return None


def curve_peak(curve):
    return max(p[1] for p in curve["points"])


def curve_at(curve, t):
    if not math.isfinite(t):
        raise ValueError("HRR time must be finite.")
    p = curve["points"]
    if t <= p[0][0]:
        return p[0][1]
    if t >= p[-1][0]:
        return p[-1][1]
    lo, hi = 0, len(p) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if p[mid][0] <= t:
            lo = mid
        else:
            hi = mid
    fraction = (t - p[lo][0]) / (p[hi][0] - p[lo][0])
    return p[lo][1] + fraction * (p[hi][1] - p[lo][1])


def t2_curve(*, alpha_kW_s2, peak_kW, hold_s, decay_s, step_s=10):
    if (not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in (alpha_kW_s2, peak_kW, hold_s, decay_s, step_s))
            or alpha_kW_s2 <= 0 or peak_kW <= 0 or hold_s < 0 or decay_s <= 0 or step_s <= 0):
        raise ValueError("t² curve needs positive alpha, peak, decay and step, and a non-negative hold.")
    growth = math.sqrt(peak_kW / alpha_kW_s2)
    end_hold = growth + hold_s
    end = end_hold + decay_s
    if not math.isfinite(end) or end <= end_hold or end / step_s > 9997:
        raise ValueError("t² curve exceeds the point or time limits.")
    times = sorted({0, growth, end_hold, end} | {i * step_s for i in range(1, math.ceil(end / step_s))})
    curve = {"points": [[t, peak_kW * (t / growth) ** 2 if t < growth else peak_kW if t <= end_hold
                         else peak_kW * ((end - t) / decay_s)] for t in times], "source": "t2"}
    problem = curve_problem(curve)
    if problem:
        raise ValueError(problem)
    return curve


def curve_from_series(t, values, max_points=200):
    def decimate_min_max(t, values, budget):
        if len(t) != len(values):
            raise ValueError("Time and value arrays must have equal lengths.")
        if isinstance(budget, bool) or not isinstance(budget, int) or budget < 2:
            raise ValueError("maxPoints must be an integer of at least 2.")
        if any(not isinstance(x, (int, float)) or isinstance(x, bool) or not math.isfinite(x) or (i > 0 and x <= t[i - 1]) for i, x in enumerate(t)):
            raise ValueError("Decimation needs finite samples with strictly increasing times.")
        if len(t) <= budget:
            return t, values
        indices = [0]
        buckets, interior = (budget - 2) // 2, len(t) - 2
        for b in range(buckets):
            start, end = 1 + b * interior // buckets, 1 + (b + 1) * interior // buckets
            low = min(range(start, end), key=lambda i: values[i])
            high = max(range(start, end), key=lambda i: values[i])
            indices.extend(sorted({low, high}))
        indices.append(len(t) - 1)
        return [t[i] for i in indices], [values[i] for i in indices]
    if len(t) < 2 or any(x < 0 for x in t) or max_points > 10000:
        raise ValueError("HRR series needs at least two non-negative times and at most 10000 output points.")
    if not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in values):
        raise ValueError("HRR series needs finite values.")
    clamped = sum(v < 0 for v in values)
    thin = decimate_min_max(t, [max(0, v) for v in values], max_points)
    return {"curve": {"points": [[float(t), float(v)] for t, v in zip(thin[0], thin[1])], "source": "measured"},
            "notes": [f"Clamped {clamped} negative HRR samples to 0 kW."] if clamped else []}
