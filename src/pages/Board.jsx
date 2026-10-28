import ImageCard from "../components/ImageCard.jsx";

function Board({ images, onShuffle, allTags, activeTag, onTagChange }) {
  return (
    <>
      <button onClick={onShuffle}>Shuffle</button>

      <div className="tags">
        <button
          className={!activeTag ? "active" : ""}
          onClick={() => onTagChange(null)}
        >
          All
        </button>
        {allTags.map((tag) => (
          <button
            key={tag}
            className={tag === activeTag ? "active" : ""}
            onClick={() => onTagChange(tag === activeTag ? null : tag)}
          >
            {tag}
          </button>
        ))}
      </div>

      <div className="board">
        {images.map((img) => (
          <ImageCard key={img.id} image={img} />
        ))}
      </div>
    </>
  );
}

export default Board;
