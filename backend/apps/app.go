package apps

// App is the public registry entry for a supported external app.
// Registry is pure app metadata; all import-specific knowledge lives in the doc.
type App struct {
	ID          string `yaml:"id" json:"id"`
	Name        string `yaml:"name" json:"name"`
	Category    string `yaml:"category" json:"category"`
	Website     string `yaml:"website,omitempty" json:"website,omitempty"`
	Description string `yaml:"description,omitempty" json:"description,omitempty"`
}

// AppDetail extends App with the rendered doc markdown (if present).
type AppDetail struct {
	App
	Doc string `json:"doc,omitempty"` // raw markdown body, "" if no doc
}
