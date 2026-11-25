import { describe, expect, it } from "vitest";
import { CATEGORY_KEYS, categoryKey, marketFor } from "./key.js";

describe("categoryKey", () => {
  it("maps every wizard preset", () => {
    expect(categoryKey("Plumbing")).toBe("plumbing");
    expect(categoryKey("Electrical")).toBe("electrical");
    expect(categoryKey("HVAC")).toBe("hvac");
    expect(categoryKey("Dentistry")).toBe("dentistry");
    expect(categoryKey("Restaurant")).toBe("restaurant");
    expect(categoryKey("Landscaping")).toBe("landscaping");
    expect(categoryKey("Auto repair")).toBe("auto");
    expect(categoryKey("Car wash")).toBe("carWash");
    expect(categoryKey("Cleaning services")).toBe("cleaning");
    expect(categoryKey("Real estate")).toBe("realEstate");
  });

  it("maps typed-in categories, first match wins", () => {
    expect(categoryKey("Lawn care")).toBe("landscaping");
    expect(categoryKey("Dental cleaning")).toBe("dentistry");
    expect(categoryKey("Auto electrical")).toBe("auto");
    for (const c of ["Hand car wash", "Carwash", "Auto detailing", "Mobile detailing", "Truck wash", "Car cleaning"]) expect(categoryKey(c), c).toBe("carWash");
    for (const c of ["Auto repair shop", "Body shop"]) expect(categoryKey(c), c).toBe("auto");
    expect(categoryKey("Pressure washing")).not.toBe("carWash");
    expect(categoryKey("Pizza place")).toBe("restaurant");
    expect(categoryKey("Heating and cooling")).toBe("hvac");
    expect(categoryKey("Drain cleaning")).toBe("plumbing");
    expect(categoryKey("Electrician")).toBe("electrical");
    expect(categoryKey("Maid service")).toBe("cleaning");
    expect(categoryKey("Realtor")).toBe("realEstate");
  });

  it("null for everything else", () => {
    for (const c of ["Other", "", "Hair salon", "Bookshop", null, undefined]) expect(categoryKey(c)).toBeNull();
  });

  it("has ten keys", () => {
    expect(CATEGORY_KEYS).toHaveLength(10);
  });
});

describe("marketFor", () => {
  it("INR is India, everything else US", () => {
    expect(marketFor("INR")).toBe("IN");
    expect(marketFor("USD")).toBe("US");
    expect(marketFor(null)).toBe("US");
  });
});
