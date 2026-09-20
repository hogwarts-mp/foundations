export interface HmpCharacterUiPlayer {
    id: number;
    emit(eventName: string, payloadJson?: string): void;
}

export interface HmpCharacterAppearancePlayer extends HmpCharacterUiPlayer {
    getTransmog?(): string;
    setTransmog?(transmog: string): void;
}

export interface HmpCharacterUiOpenOptions {
    mode?: "join" | "create" | "wardrobe" | string;
}

export interface HmpCharacterCard {
    id: number;
    slot: number;
    name: string;
}

export interface HmpCharacterLook {
    characterId: number;
    appearance: string;
    transmog: string;
}

export interface HmpCharacterUiModel {
    mode: string;
    title: string;
    subtitle: string;
    characters: HmpCharacterCard[];
    activeCharacterId: number | null;
    lastCharacterId: number | null;
    limit: number;
    full: boolean;
    allowDelete: boolean;
    canClose: boolean;
}

export interface HmpCharactersUi<P extends HmpCharacterUiPlayer = HmpCharacterUiPlayer> {
    open(player: P, options?: HmpCharacterUiOpenOptions): Promise<HmpCharacterUiModel>;
    close(player: P): boolean;
}

export interface HmpCharactersAppearance<P extends HmpCharacterAppearancePlayer = HmpCharacterAppearancePlayer> {
    getTransmog(player: P): Promise<string>;
    listTransmogs(): string[];
    setTransmog(player: P, transmog: string): Promise<boolean>;
    clearTransmog(player: P): Promise<boolean>;
}

export interface HmpCharacters<P extends HmpCharacterAppearancePlayer = HmpCharacterAppearancePlayer> {
    ui: HmpCharactersUi<P>;
    appearance: HmpCharactersAppearance<P>;
}
