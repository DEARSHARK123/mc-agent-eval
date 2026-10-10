export const INNATE_SKILLS = [
  {
    name: 'pick_up_nearby',
    description: 'Pick up nearby dropped items.',
    body: [{ primitive: 'collectDrops', params: { radius: 6 } }],
  },
];

export function seedInnateSkills(library) {
  for (const draft of INNATE_SKILLS) {
    if (!library.has(draft.name)) {
      library.learn(draft, { teacherUuid: 'innate', context: 'Innate skill.', route: 'innate' });
    }
  }
}
