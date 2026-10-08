type Props = {
  value: string;
  onChange: (value: string) => void;
};

export function SearchBar({ value, onChange }: Props) {
  return (
    <div className="search">
      <input
        type="search"
        placeholder="Search module…"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Search module"
      />
    </div>
  );
}
