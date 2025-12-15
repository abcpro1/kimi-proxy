import {
  CheckCircle,
  XCircle,
  Upload,
  Bot,
  Wrench,
  Calendar,
  AlertTriangle,
  Target,
  Tag,
  Lightbulb,
  Clock,
  X,
  Filter,
} from "lucide-react";
import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  forwardRef,
} from "react";

interface SearchFiltersProps {
  search: string;
  onSearchChange: (value: string) => void;
  selectedModel: string;
  onModelChange: (value: string) => void;
  selectedProvider: string;
  onProviderChange: (value: string) => void;
  selectedStatus: string;
  onStatusChange: (value: string) => void;
  models: string[];
  providers: string[];
}

interface SearchSuggestion {
  text: string;
  type: "recent" | "field" | "example";
  description?: React.ReactNode;
}

const SearchFilters = forwardRef<HTMLInputElement, SearchFiltersProps>(
  (
    {
      search,
      onSearchChange,
      selectedModel,
      onModelChange,
      selectedProvider,
      onProviderChange,
      selectedStatus,
      onStatusChange,
      models,
      providers,
    },
    ref,
  ) => {
    const [showFilters, setShowFilters] = useState(false);
    const [showSuggestions, setShowSuggestions] = useState(false);
    const [suggestions, setSuggestions] = useState<SearchSuggestion[]>([]);
    const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(-1);
    const searchInputRef = useRef<HTMLInputElement | null>(null);
    const searchInputWrapperRef = useRef<HTMLDivElement | null>(null);
    const suggestionsRef = useRef<HTMLDivElement>(null);

    const setInputRef = useCallback(
      (node: HTMLInputElement | null) => {
        searchInputRef.current = node;
        if (typeof ref === "function") {
          ref(node);
        } else if (ref) {
          ref.current = node;
        }
      },
      [ref],
    );

    // Example search queries for suggestions
    const exampleSearches = [
      {
        text: "status:200",
        type: "example" as const,
        description: (
          <>
            {" "}
            <CheckCircle size={14} className="icon-success" /> Successful
            requests only{" "}
          </>
        ),
      },
      {
        text: "status:4xx OR status:5xx",
        type: "example" as const,
        description: (
          <>
            {" "}
            <XCircle size={14} className="icon-error" /> Error responses{" "}
          </>
        ),
      },
      {
        text: "method:POST",
        type: "example" as const,
        description: (
          <>
            {" "}
            <Upload size={14} /> POST requests only{" "}
          </>
        ),
      },
      {
        text: "model:gpt-4",
        type: "example" as const,
        description: (
          <>
            {" "}
            <Bot size={14} /> GPT-4 model requests{" "}
          </>
        ),
      },
      {
        text: "provider:openai",
        type: "example" as const,
        description: (
          <>
            {" "}
            <Wrench size={14} /> OpenAI provider only{" "}
          </>
        ),
      },
      {
        text: "timestamp:>2024-01-01",
        type: "example" as const,
        description: (
          <>
            {" "}
            <Calendar size={14} /> Recent requests{" "}
          </>
        ),
      },
      {
        text: "error OR failed OR exception",
        type: "example" as const,
        description: (
          <>
            {" "}
            <AlertTriangle size={14} className="icon-error" /> Error logs{" "}
          </>
        ),
      },
      {
        text: "model:kimi-k2-thinking",
        type: "example" as const,
        description: (
          <>
            {" "}
            <Target size={14} /> Kimi K2 Thinking model{" "}
          </>
        ),
      },
    ];

    // Field-based suggestions
    const fieldSuggestions = [
      {
        text: "status:",
        type: "field" as const,
        description: "Filter by status code",
      },
      {
        text: "method:",
        type: "field" as const,
        description: "Filter by HTTP method",
      },
      {
        text: "model:",
        type: "field" as const,
        description: "Filter by model name",
      },
      {
        text: "provider:",
        type: "field" as const,
        description: "Filter by provider",
      },
      {
        text: "timestamp:",
        type: "field" as const,
        description: "Filter by date/time",
      },
    ];

    // Generate suggestions based on current input
    const generateSuggestions = useCallback(
      (query: string) => {
        const lowerQuery = query.toLowerCase();
        const allSuggestions: SearchSuggestion[] = [];

        // Add field suggestions if query is empty or starting a field
        if (!query || lowerQuery.match(/^\w*:?$/)) {
          allSuggestions.push(...fieldSuggestions);
        }

        // Add example searches
        allSuggestions.push(...exampleSearches);

        // Add model suggestions
        models.forEach((model) => {
          if (model.toLowerCase().includes(lowerQuery)) {
            allSuggestions.push({
              text: `model:${model}`,
              type: "field",
              description: `Filter by ${model} model`,
            });
          }
        });

        // Add provider suggestions
        providers.forEach((provider) => {
          if (provider.toLowerCase().includes(lowerQuery)) {
            allSuggestions.push({
              text: `provider:${provider}`,
              type: "field",
              description: `Filter by ${provider} provider`,
            });
          }
        });

        return allSuggestions.slice(0, 8);
      },
      [models, providers],
    );

    // Update suggestions when search changes
    useEffect(() => {
      setSuggestions(generateSuggestions(search));
      setActiveSuggestionIndex(-1);
    }, [search, generateSuggestions]);

    // Close suggestions when clicking outside the search input area
    useEffect(() => {
      if (!showSuggestions) return;

      const handleMouseDown = (event: MouseEvent) => {
        if (!(event.target instanceof Node)) return;
        if (searchInputWrapperRef.current?.contains(event.target)) return;

        setShowSuggestions(false);
        setActiveSuggestionIndex(-1);
        searchInputRef.current?.blur();
      };

      document.addEventListener("mousedown", handleMouseDown);
      return () => document.removeEventListener("mousedown", handleMouseDown);
    }, [showSuggestions]);

    // Handle keyboard navigation
    const handleKeyDown = (e: React.KeyboardEvent) => {
      if (!showSuggestions) return;

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setActiveSuggestionIndex((prev) =>
            prev < suggestions.length - 1 ? prev + 1 : 0,
          );
          break;
        case "ArrowUp":
          e.preventDefault();
          setActiveSuggestionIndex((prev) =>
            prev > 0 ? prev - 1 : suggestions.length - 1,
          );
          break;
        case "Enter":
          e.preventDefault();
          if (activeSuggestionIndex >= 0) {
            const suggestion = suggestions[activeSuggestionIndex];
            onSearchChange(suggestion.text);
            setShowSuggestions(false);
            setActiveSuggestionIndex(-1);
          }
          break;
        case "Escape":
          setShowSuggestions(false);
          setActiveSuggestionIndex(-1);
          searchInputRef.current?.blur();
          break;
      }
    };

    // Handle suggestion click
    const handleSuggestionClick = (suggestion: SearchSuggestion) => {
      onSearchChange(suggestion.text);
      setShowSuggestions(false);
      setActiveSuggestionIndex(-1);
      searchInputRef.current?.focus();
    };

    // Clear search
    const handleClearSearch = () => {
      onSearchChange("");
      searchInputRef.current?.focus();
    };

    // Get active filter count
    const getActiveFilterCount = () => {
      let count = 0;
      if (selectedModel) count++;
      if (selectedProvider) count++;
      if (selectedStatus) count++;
      return count;
    };

    // Clear all filters
    const handleClearAllFilters = () => {
      onSearchChange("");
      onModelChange("");
      onProviderChange("");
      onStatusChange("");
    };

    // Keyboard shortcut hint
    const getKeyboardHint = () => {
      const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
      return isMac ? "⌘K" : "Ctrl+K";
    };

    return (
      <div className="search-filters">
        <div className="search-main">
          <div ref={searchInputWrapperRef} className="search-input-wrapper">
            <svg
              className="search-icon"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
            <input
              ref={setInputRef}
              type="text"
              className="search-input"
              placeholder="Search logs... (try 'status:200' or 'model:gpt-4')"
              value={search}
              onChange={(e) => {
                onSearchChange(e.target.value);
                setShowSuggestions(true);
              }}
              onKeyDown={handleKeyDown}
              onBlur={() => {
                setShowSuggestions(false);
                setActiveSuggestionIndex(-1);
              }}
              onFocus={() => {
                if (suggestions.length > 0) {
                  setShowSuggestions(true);
                }
              }}
            />
            {search && (
              <button
                className="search-clear"
                onClick={handleClearSearch}
                title="Clear search"
              >
                <X size={14} />
              </button>
            )}

            {/* Suggestions Dropdown */}
            {showSuggestions && (
              <div
                ref={suggestionsRef}
                className="search-suggestions"
                onMouseDown={(e) => e.preventDefault()}
              >
                {suggestions.map((suggestion, index) => (
                  <div
                    key={index}
                    className={`suggestion-item ${index === activeSuggestionIndex ? "active" : ""}`}
                    onClick={() => handleSuggestionClick(suggestion)}
                  >
                    <div className="suggestion-content">
                      <span className="suggestion-text">{suggestion.text}</span>
                      {suggestion.description && (
                        <span className="suggestion-description">
                          {suggestion.description}
                        </span>
                      )}
                    </div>
                    <div className="suggestion-type">
                      {suggestion.type === "field" && <Tag size={14} />}
                      {suggestion.type === "example" && <Lightbulb size={14} />}
                      {suggestion.type === "recent" && <Clock size={14} />}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <button
            className={`filters-toggle ${getActiveFilterCount() > 0 ? "has-filters" : ""}`}
            onClick={() => setShowFilters(!showFilters)}
            aria-expanded={showFilters}
          >
            <Filter size={16} />
            Filters
            {getActiveFilterCount() > 0 && (
              <span className="filter-count">{getActiveFilterCount()}</span>
            )}
          </button>

          <div
            className="search-shortcut"
            title={`Press ${getKeyboardHint()} to focus search`}
          >
            {getKeyboardHint()}
          </div>
        </div>

        {showFilters && (
          <div className="filters-panel">
            <div className="filter-group">
              <label>Model</label>
              <select
                value={selectedModel}
                onChange={(e) => onModelChange(e.target.value)}
              >
                <option value="">All Models</option>
                {models.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            </div>

            <div className="filter-group">
              <label>Provider</label>
              <select
                value={selectedProvider}
                onChange={(e) => onProviderChange(e.target.value)}
              >
                <option value="">All Providers</option>
                {providers.map((provider) => (
                  <option key={provider} value={provider}>
                    {provider}
                  </option>
                ))}
              </select>
            </div>

            <div className="filter-group">
              <label>Status</label>
              <select
                value={selectedStatus}
                onChange={(e) => onStatusChange(e.target.value)}
              >
                <option value="">All Status</option>
                <option value="success">Success (2xx)</option>
                <option value="error">Error (4xx, 5xx)</option>
              </select>
            </div>

            {(selectedModel || selectedProvider || selectedStatus) && (
              <button
                className="clear-filters-btn"
                onClick={handleClearAllFilters}
              >
                Clear All
              </button>
            )}
          </div>
        )}
      </div>
    );
  },
);

export default SearchFilters;
