import type {
  AnchorResolverDependencies,
  AnnotationResolver,
  WordLookup,
} from "./types.js";

export class AnchorResolverRegistry {
  #wordLookup: WordLookup | undefined;
  #annotationResolver: AnnotationResolver | undefined;

  public registerWordLookup(lookup: WordLookup): void {
    this.#wordLookup = lookup;
  }

  public registerAnnotationResolver(resolver: AnnotationResolver): void {
    this.#annotationResolver = resolver;
  }

  public dependencies(): AnchorResolverDependencies {
    return {
      ...(this.#wordLookup === undefined ? {} : { wordLookup: this.#wordLookup }),
      ...(this.#annotationResolver === undefined
        ? {}
        : { annotationResolver: this.#annotationResolver }),
    };
  }
}
