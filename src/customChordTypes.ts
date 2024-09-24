import { ChordType } from "tonal";

interface CustomChordType {
	intervals: string[];
	aliases: string[];
	name: string;
}

const customChordTypes: CustomChordType[] = [
	extendChordType("7#5", { aliases: ["7(5+)", "7(+5)", "7+5"] }),
	extendChordType("M7", { aliases: ["7M"] }),
	extendChordType("m9", { aliases: ["m7(9)"] }),
	{
		name: "suspended four sharp five",
		intervals: ["1P", "4P", "5A"],
		aliases: ["sus4#5", "4(5+)"]
	}
];

function extendChordType(type: string, chordTypeExtension: Partial<CustomChordType> ): CustomChordType {
	const originalChordType = ChordType.get(type);
	if (originalChordType.empty) {
		throw new Error(`Error while extending chord type: chord type ${type} not found.`);
	}
	const mergedAliases = [...originalChordType.aliases, ...(chordTypeExtension.aliases || [])];
	return {
		...originalChordType,
		...chordTypeExtension,
		aliases: mergedAliases
	};
}

export function addCustomChordTypes() {
	customChordTypes.forEach(({ intervals, aliases, name }) => {
		ChordType.add(intervals, aliases, name);
	});
}