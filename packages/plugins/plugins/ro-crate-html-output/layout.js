// Resolves a MASP profile's crate-o-mode.json propertyGroups into the layout
// used to group properties in the HTML preview. Profiles are standalone —
// there is no generic fallback layout merged in; a profile that wants a
// property shown must declare it itself.
//
// Resolves each group's property names (e.g. "inLanguage", "custom:portalName")
// to full URIs against the built crate's own context — the same context
// collectDescribeValues() wrote the actual properties under, so the
// resolved URI is guaranteed to match what's really on the entity. Profiles
// are expected to declare properly prefixed names for anything that isn't a
// real schema.org term (crate.resolveTerm() only resolves terms it can
// actually find — confirmed by testing that a bare, invented name like
// "portalName" resolves to undefined). An input that doesn't resolve is
// dropped rather than guessed at, and a group left with no resolvable inputs
// is dropped entirely.
export function resolveProfileGroups(crate, propertyGroups) {
  if (!Array.isArray(propertyGroups)) return [];
  return propertyGroups
    .map((group) => {
      const inputs = (group.inputs || [])
        .map((name) => crate.resolveTerm(name))
        .filter(Boolean);
      return { name: group.name, inputs };
    })
    .filter((group) => group.inputs.length > 0);
}
